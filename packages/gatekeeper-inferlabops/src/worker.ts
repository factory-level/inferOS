// InferLab operations (FAC-235): a person's own, explicit connection to their InferOps records, so
// their Gadgets can read one Project's Locations and request reviews with exactly that person's
// InferOps authority. Signing in to InferOS (gatekeeper-inferlab) never creates it.
//
// - Connect: authorization code + PKCE at INFERLAB_AUTH_ORIGIN for the `inferos` client, returning
//   to `<BASE_URL>/oauth` (inferops INFEROS_OPERATIONS_CALLBACK_PATH). InferOps refuses a session
//   in another company than the InferOS origin names, and this gatekeeper checks the company again.
// - Tokens live only in the person's OperationsAccount Durable Object: rotating refresh, immediate
//   revoke, never in a URL, a log or the Workshop.
// - Every call is validated live by InferOps with the person's own token. Nothing is cached, so a
//   revoked grant or connection stops the next read.
// - A binding is one Project. Each read reports the Project and every Location it discloses as
//   subresources, and a collaborator is admitted only if their OWN connection can read them all
//   now, so nothing an owner's Gadget read is inherited, cached or historical.
// - The attention authority (FAC-237) answers who may see an attention target with each person's
//   own connection, live.
//
// Ported in part from the archived fork (archive/main-2026-11-14, 24f5d885) and from
// gatekeeper-inferlab (FAC-214); README.md is the ledger of what was taken and what was left.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { advanceToOAuth, claimOAuth, putInitiation } from "@gadgets/gatekeeper-kit/connect-handshake";
import {
  INITIATION_NONCE_LIFETIME_MS, NONCE_BYTES, OAUTH_NONCE_LIFETIME_MS, generateNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  INVALID_LINK_HTML, connectHandoffPageHtml, errorPageHtml, htmlResponse,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { CredentialSource, isCredentialsExpired } from "@gadgets/gatekeeper-kit/credentials";
import { createPkce } from "@gadgets/gatekeeper-kit/oauth-client";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import { GLOBAL_SUBRESOURCE_ID, formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import { createLogger } from "@gadgets/observability/logger";
import type {
  AccountDescription, ActionKind, ApprovalQueue, ConnectHandoff, Gatekeeper, GatekeeperConnectCallback,
  GatekeeperConnectOptions, GatekeeperSubject, GatekeeperUser, GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface, ObservationDescription, ResourceConfiguratorFrame,
  ResourceDescription, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { type CallCredentials, OperationsAccount, SubjectIndex, VENDOR_ID, isDefiniteNo, subjectIndexName } from "./account";
import { DESTINATION_KEY, EVENTS_PATH, GATEKEEPER_PATH, type OperationsConfig, readConfig, receivesEventsFor, redirectUriFor } from "./config";
import {
  EVENTS_NOT_CONFIGURED, EVENT_TYPES, type ProjectEventDelivery, type ProjectEventHookTarget, type StoredEvent,
  eventHookDescription, forgetEventHooks, handleEventDelivery,
} from "./events";
import {
  ConnectFailure, INFERLAB_CLIENT_ID, InferOpsApiError, type LocationRecord, OTHER_COMPANY, type ProjectRecord,
  apiRequest, exchangeCode, locationOf, locationPageOf, logout, projectOf,
} from "./inferops-api";
import type { Location, LocationPage, Project, ProjectEvent, ProjectSession } from "./types";
import PROJECT_CONFIGURATOR_HTML from "./generated/project-configurator-ui.txt";
import TYPES_CODE from "./types.txt";
import { visibleName } from "./label";

export { OperationsAccount, SubjectIndex };
export { ProjectEventDriver, ProjectEventHookController } from "./events";

const logger = createLogger<{ vendorId: string }>({ component: "gatekeeper.inferlabops", vendorId: VENDOR_ID });

const CALLBACK_KEY = "callback";
const HEX_64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOGO_URL = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" ' +
  'fill="#0f766e"/><text x="16" y="22" font-size="14" text-anchor="middle" fill="#fff" ' +
  'font-family="sans-serif">OPS</text></svg>');
const EXPIRED = "Your InferLab operations connection has expired or was revoked. Reconnect it in the Workshop.";

/** The one resource kind: one InferOps Project, by its `inferops://` address. */
export const PROJECT_RESOURCE: SupportedResource = {
  urlPattern: "inferops://*.*/project/project/*",
  title: "InferOps Project",
  description: "One Project and its Locations, read and reviewed with your own InferOps access.",
  grantable: true,
};

/** The one action kind. */
export const REQUEST_REVIEW_KIND: ActionKind = { tag: "request-review", label: "Request Location reviews" };

type OAuthExtra = { codeVerifier: string; redirectUri: string };

function configOrThrow(env: Cloudflare.Env): OperationsConfig {
  const config = readConfig(env);
  if ("off" in config) {
    logger.error("InferLab operations is not configured", { event: "inferlabops.not_configured" });
    throw new Error(config.off);
  }
  return config;
}

const accountStub = (ctx: { exports: Cloudflare.Exports }, accountId: string) =>
  ctx.exports.OperationsAccount.get(ctx.exports.OperationsAccount.idFromString(accountId));

/** A gadget-facing error with one of the documented names (types.d.ts). */
function named(name: "NotFound" | "Forbidden" | "StaleRevision" | "Conflict" | "IdempotencyConflict" | "ConnectionExpired",
               message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** InferOps' answer, as the error the Gadget is documented to see. Never the response body. */
function toGadgetError(error: unknown): Error {
  if (isCredentialsExpired(error)) return named("ConnectionExpired", EXPIRED);
  if (error instanceof InferOpsApiError) {
    if (error.status === 404) return named("NotFound", "Not found.");
    if (error.status === 403) return named("Forbidden", "Your InferOps access doesn't allow this.");
    if (error.status === 409 && error.code === "STALE_REVISION") {
      return named("StaleRevision", "The Location changed since you read it. Read it again and retry.");
    }
    if (error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT") {
      return named("IdempotencyConflict",
        "InferOps already used this request's key for a different request, so it changed nothing.");
    }
    if (error.status === 409) return named("Conflict", "A review is already waiting for this Location.");
  }
  return error instanceof Error ? error : new Error("InferOps failed.");
}

// ── Connect ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One connect attempt: the Workshop's callback, the handshake nonces and the PKCE verifier.
 * Deleted once used or expired.
 */
@validateRpc()
export class ConnectAttempt extends DurableObject<Cloudflare.Env> {
  @skipRpcValidation()
  async start(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.kv.put(CALLBACK_KEY, callback);
    putInitiation(this.ctx.storage.kv, initiationNonce, now);
    await this.ctx.storage.setAlarm(now + INITIATION_NONCE_LIFETIME_MS + OAUTH_NONCE_LIFETIME_MS);
  }

  async begin(initiationNonce: string, redirectUri: string)
      : Promise<{ oauthNonce: string; codeChallenge: string } | null> {
    const pkce = await createPkce();
    const oauthNonce = advanceToOAuth<OAuthExtra>(this.ctx.storage.kv, initiationNonce, Date.now(), {
      codeVerifier: pkce.codeVerifier, redirectUri,
    });
    return oauthNonce === null ? null : { oauthNonce, codeChallenge: pkce.codeChallenge };
  }

  async abandon(oauthNonce: string): Promise<boolean> {
    if (claimOAuth(this.ctx.storage.kv, oauthNonce, Date.now()) === null) return false;
    await this.#forget();
    return true;
  }

  /**
   * Exchanges the code for the person's own tokens, stores them in a new account, and hands the
   * Workshop that account. Null when the state is unknown, spent or expired; `{ error }` with a
   * message safe to show when the connection fails.
   */
  async complete(code: string, oauthNonce: string)
      : Promise<{ handoff: ConnectHandoff } | { error: string } | null> {
    const flow = claimOAuth<OAuthExtra>(this.ctx.storage.kv, oauthNonce, Date.now());
    if (flow === null) return null;
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>(CALLBACK_KEY);
    try {
      if (!callback) return null;
      const config = readConfig(this.env);
      if ("off" in config) return { error: config.off };
      const { grant, identity } = await exchangeCode(config.origin, code, flow.codeVerifier, flow.redirectUri);
      if (identity.tenantId !== config.tenantId) {
        // InferOps already refuses this (ADR 0009 T6); a second check costs nothing.
        await logout(config.origin, grant.refreshToken);
        logger.warn("InferLab session from another company refused", { event: "inferlabops.other_company" });
        throw new ConnectFailure(OTHER_COMPANY);
      }
      const accountId = this.ctx.exports.OperationsAccount.newUniqueId();
      await this.ctx.exports.OperationsAccount.get(accountId).install(grant, identity, callback);
      await this.ctx.exports.SubjectIndex.get(this.ctx.exports.SubjectIndex.idFromName(subjectIndexName(identity)))
        .remember(accountId.toString());
      const user = this.ctx.exports.OperationsUser({ props: { accountId: accountId.toString() } }) as
        unknown as Fetcher<GatekeeperUser>;
      return { handoff: await callback.complete(user) };
    } catch (error) {
      if (error instanceof ConnectFailure) return { error: error.message };
      logger.error("InferLab operations connect failed", { event: "inferlabops.connect_failed", error });
      return { error: "Connecting InferLab operations failed. Close this window and try again." };
    } finally {
      await this.#forget();
    }
  }

  async alarm(): Promise<void> {
    await this.#forget();
  }

  async #forget(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "InferLab operations",
      url: "https://inferlab.dev",
      logo: { url: LOGO_URL },
      color: "#ecfdf5",
      tagline: "Your InferOps Projects and Locations, with your own access",
      description: "Lets your Gadgets read one InferOps Project and its Locations, and request reviews, " +
        "with exactly your own InferOps access. Connecting is separate from signing in.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    // This gatekeeper never signs anyone in: that is gatekeeper-inferlab's, and grants nothing.
    if (options?.scopes === "auth") throw new Error("InferLab operations doesn't sign you in.");
    const config = configOrThrow(this.env);
    const id = this.ctx.exports.ConnectAttempt.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.ConnectAttempt.get(id).start(callback, nonce);
    return { url: `${config.baseUrl}/${id.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [PROJECT_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ── The person's account ────────────────────────────────────────────────────────────────────────

type UserProps = { accountId: string };

/** The binding a `inferops://` Project address names, or null when it isn't one. */
export function parseProjectAddress(url: string): { tenantSlug: string; workspaceSlug: string; projectId: string } | null {
  const match = /^inferops:\/\/([a-z0-9-]+)\.([a-z0-9-]+)\/project\/project\/([0-9a-f-]{36})$/.exec(url);
  if (!match || !SLUG.test(match[1]!) || !SLUG.test(match[2]!) || !UUID.test(match[3]!)) return null;
  return { tenantSlug: match[1]!, workspaceSlug: match[2]!, projectId: match[3]! };
}

/** The Project picker's capability: address shape only, nothing read. */
class ProjectConfiguratorUI extends RpcTarget {
  async resourceUrl(address: string | null | undefined): Promise<string> {
    const parsed = typeof address === "string" ? parseProjectAddress(address.trim()) : null;
    if (!parsed) throw new Error("That isn't an InferOps Project address.");
    return `inferops://${parsed.tenantSlug}.${parsed.workspaceSlug}/project/project/${parsed.projectId}`;
  }
}

@validateRpc()
export class OperationsUser extends WorkerEntrypoint<Cloudflare.Env, UserProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    const identity = await accountStub(this.ctx, this.ctx.props.accountId).identity();
    const name = identity ? `InferLab ${identity.subject}` : "InferLab operations (disconnected)";
    return { displayName: name, uniqueName: name, avatar: { url: LOGO_URL } };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [PROJECT_RESOURCE];
  }

  /**
   * The facet for one Project address. The address's company must be this person's (and so the
   * deployment's), its workspace one they hold a live grant in, and the Project one they can read
   * now. A locator grants nothing: each of those is checked with their own token.
   */
  async getGatekeeperClassFor(url: string)
      : Promise<{ class: DurableObjectClass<Gatekeeper<ProjectSession>>; resource: SupportedResource }> {
    const address = parseProjectAddress(url);
    if (!address) throw new Error("That isn't an InferOps Project address (inferops://<company>.<workspace>/project/project/<id>).");
    const account = accountStub(this.ctx, this.ctx.props.accountId);
    const company = await account.company();
    if (company.slug !== address.tenantSlug) throw named("NotFound", "That Project isn't in your company.");
    const workspace = company.workspaces.find(w => w.slug === address.workspaceSlug);
    if (!workspace) throw named("NotFound", "You don't hold that InferOps workspace.");
    if (!await account.canRead(`/project/projects/${address.projectId}`, workspace.id)) {
      throw named("NotFound", "You can't see that Project.");
    }
    const props: ProjectProps = {
      accountId: this.ctx.props.accountId,
      tenantId: company.tenantId,
      tenantSlug: company.slug,
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      projectId: address.projectId,
    };
    return { class: this.ctx.exports.ProjectGatekeeper({ props }), resource: PROJECT_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== PROJECT_RESOURCE.urlPattern) {
      throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    }
    // The frame's only capability: turn a typed address into a canonical one. It reads no InferOps
    // data, so it can reveal nothing; binding checks the company, workspace and Project live.
    return { iframeHtml: PROJECT_CONFIGURATOR_HTML, ui: new RpcStub(new ProjectConfiguratorUI()) };
  }

  async revoke(): Promise<void> {
    // Its hooks go too (FAC-236), whatever signing out does: a disconnected connection delivers nothing.
    try {
      await forgetEventHooks(this.ctx.exports, this.ctx.props.accountId);
    } finally {
      await accountStub(this.ctx, this.ctx.props.accountId).revoke();
    }
  }

  async reconnect(): Promise<{ url: string }> {
    throw new Error("Disconnect InferLab operations, then connect it again.");
  }

  async commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Disconnect InferLab operations, then connect it again.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getAuthenticatedSubject(): Promise<GatekeeperSubject | null> {
    const identity = await accountStub(this.ctx, this.ctx.props.accountId).identity();
    return identity ? { issuer: identity.issuer, subject: identity.subject } : null;
  }

  /**
   * This person's verifier, for observer checks. Not RPC-validated, like every gatekeeper's: the
   * validator wraps a returned `Fetcher` in a Proxy that Workers RPC refuses to serialize.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.OperationsVerifier({ props: { accountId: this.ctx.props.accountId } });
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
}

// ── Observer verification: the OBSERVER's own connection ────────────────────────────────────────

/** What this vendor's verifier can answer, with its own person's token. */
export interface OperationsVerifierApi extends GatekeeperUserVerifier {
  /** For each subresource, whether this person can read it now. Throws when that can't be told. */
  canReadAll(subresources: string[]): Promise<boolean[]>;
}

/** A parsed subresource id this gatekeeper reports. */
type Reported =
  | { kind: "project"; tenantId: string; workspaceId: string; id: string }
  | { kind: "location"; tenantId: string; workspaceId: string; id: string };

function projectSubresource(p: { tenantId: string; workspaceId: string; projectId: string }): string {
  return formatSubresourceId({ fragments: [
    { name: "tenant", id: p.tenantId }, { name: "workspace", id: p.workspaceId }, { name: "project", id: p.projectId },
  ] });
}

function locationSubresource(p: { tenantId: string; workspaceId: string }, locationId: string): string {
  return formatSubresourceId({ fragments: [
    { name: "tenant", id: p.tenantId }, { name: "workspace", id: p.workspaceId }, { name: "location", id: locationId },
  ] });
}

/** Decodes an id this gatekeeper reported; refuses anything else rather than guessing. */
export function parseReported(id: string): Reported {
  const refused = () => new Error("This connection was asked about a resource it never reports.");
  if (id === GLOBAL_SUBRESOURCE_ID) throw refused();
  let parsed: ReturnType<typeof parseSubresourceId>;
  try {
    parsed = parseSubresourceId(id);
  } catch {
    throw refused();
  }
  const [tenant, workspace, item, extra] = parsed.fragments;
  if (parsed.namespace !== undefined || extra || tenant?.name !== "tenant" || workspace?.name !== "workspace" ||
      (item?.name !== "project" && item?.name !== "location") ||
      !UUID.test(tenant.id) || !UUID.test(workspace.id) || !UUID.test(item.id)) throw refused();
  return { kind: item.name, tenantId: tenant.id, workspaceId: workspace.id, id: item.id };
}

type VerifierProps = { accountId: string };

@validateRpc()
export class OperationsVerifier extends WorkerEntrypoint<Cloudflare.Env, VerifierProps> implements OperationsVerifierApi {
  /**
   * With this person's own token: a Project id needs `project.read`, a Location id `location.read`,
   * both in the id's workspace and company. A 200 is yes; a 403 or 404, or another company, is a
   * definite no. An outage or a session InferLab has ended throws: access can't be determined.
   */
  async canReadAll(subresources: string[]): Promise<boolean[]> {
    const account = accountStub(this.ctx, this.ctx.props.accountId);
    const identity = await account.identity();
    if (!identity) return subresources.map(() => false);
    return Promise.all(subresources.map(async id => {
      const r = parseReported(id);
      if (r.tenantId !== identity.tenantId) return false;
      const path = r.kind === "project" ? `/project/projects/${r.id}` : `/project/locations/${r.id}`;
      return account.canRead(path, r.workspaceId);
    }));
  }
}

// ── The facet: one Project ─────────────────────────────────────────────────────────────────────

type ProjectProps = {
  accountId: string;
  tenantId: string;
  tenantSlug: string;
  workspaceId: string;
  workspaceSlug: string;
  projectId: string;
};

/** A review request waiting for the person's decision, in this facet's own storage. */
type PendingReview = { locationId: string; expectedRevision: string; idempotencyKey: string };

const PENDING_PREFIX = "pending-review:";
const NEXT_ACTION_KEY = "next-action";
/**
 * This binding's own random id, made on first use and kept in the facet's own storage. Facets get
 * no id of their own (they carry the workspace's), so two bindings in one workspace would
 * otherwise derive the same idempotency keys.
 */
const BINDING_ID_KEY = "binding-id";

@validateRpc()
export class ProjectGatekeeper extends DurableObject<Cloudflare.Env, ProjectProps> implements Gatekeeper<ProjectSession> {
  readonly #creds = new CredentialSource<CallCredentials>({
    account: () => accountStub(this.ctx, this.ctx.props.accountId),
    isAuthError: error => error instanceof InferOpsApiError && error.status === 401,
    expiredMessage: EXPIRED,
    vendorId: VENDOR_ID,
  });

  async describe(): Promise<ResourceDescription> {
    const p = this.ctx.props;
    return {
      url: `inferops://${p.tenantSlug}.${p.workspaceSlug}/project/project/${p.projectId}`,
      title: "InferOps Project",
      snippet: `Project ${p.projectId} in ${p.workspaceSlug}`,
      suggestedBindingName: "INFEROPS_PROJECT",
      tsType: "ProjectSession",
      hookTsType: "ProjectEventHook",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [REQUEST_REVIEW_KIND];
  }

  @skipRpcValidation()
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ProjectSession> {
    // The session reaches InferOps only through these closures: none of them is an RPC method of
    // this facet, so nothing holding the facet stub can make an arbitrary InferOps call.
    return new ProjectSessionImpl(approvalQueue.dup(), this.#access());
  }

  /** The closures a session or a hook delivery reaches InferOps through. */
  #access(): FacetAccess {
    return {
      props: this.ctx.props,
      call: (path, parse, options) => this.#call(path, parse, options),
      pendingReviews: () => this.#pendingReviews(),
      queueReview: (locationId, expectedRevision) => this.#queueReview(locationId, expectedRevision),
      subscribe: (queue, hook) => this.#subscribe(queue, hook),
    };
  }

  /**
   * Bind a hook on this Project's events (FAC-236): through the Workshop, which keeps it disabled
   * until the user enables it. Its scope is this binding's, carried by the controller's props.
   */
  async #subscribe(queue: RpcStub<ApprovalQueue>, hook: RpcStub<ProjectEventHookTarget>): Promise<void> {
    const p = this.ctx.props;
    if (!receivesEventsFor(this.env, p.workspaceId)) throw new Error(EVENTS_NOT_CONFIGURED);
    // Refuses before the user is asked if the person can't read the Project now.
    await this.#call(`/project/projects/${p.projectId}`, projectOf);
    using delivery: RpcStub<ProjectEventDelivery> = await this.ctx.restore({ kind: "project-events" });
    const controller = this.ctx.exports.ProjectEventHookController({ props: {
      key: crypto.randomUUID(), accountId: p.accountId, tenantId: p.tenantId, workspaceId: p.workspaceId,
      projectId: p.projectId, types: [...EVENT_TYPES], delivery,
    } });
    // @ts-expect-error Workers widens the controller's hook type across bindHook RPC.
    await queue.bindHook(controller, hook, eventHookDescription(p.projectId));
  }

  /** The target of a hook's delivery stub, minted by `#subscribe`. */
  [restore](_params: { kind: "project-events" }): ProjectEventDelivery {
    return new ProjectEventDeliveryImpl(this.#access());
  }

  /** One InferOps call with the person's own, current token. */
  async #call<T>(path: string, parse: (value: unknown) => T, options: {
    method?: "GET" | "POST"; idempotencyKey?: string; body?: unknown;
  } = {}): Promise<T> {
    const config = configOrThrow(this.env);
    try {
      return await this.#creds.run(async creds => parse(await apiRequest(config.origin, creds.token, path, {
        ...options, workspaceId: this.ctx.props.workspaceId,
      })), { replayable: (options.method ?? "GET") === "GET" || options.idempotencyKey !== undefined });
    } catch (error) {
      throw toGadgetError(error);
    }
  }

  /** Pending review requests, for simulation: reads show them as requested until decided. */
  #pendingReviews(): Map<string, PendingReview> {
    const pending = new Map<string, PendingReview>();
    for (const [, value] of this.ctx.storage.kv.list<PendingReview>({ prefix: PENDING_PREFIX })) {
      pending.set(value.locationId, value);
    }
    return pending;
  }

  /** This binding's random id (32 hex), made once and kept in its own storage. */
  #bindingId(): string {
    const existing = this.ctx.storage.kv.get<string>(BINDING_ID_KEY);
    if (existing) return existing;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const id = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    this.ctx.storage.kv.put(BINDING_ID_KEY, id);
    return id;
  }

  /** Records a review request and returns its action id. */
  #queueReview(locationId: string, expectedRevision: string): number {
    const actionId = (this.ctx.storage.kv.get<number>(NEXT_ACTION_KEY) ?? 0) + 1;
    this.ctx.storage.kv.put(NEXT_ACTION_KEY, actionId);
    // Derived from this binding and the action, so a retried apply of the same action replays
    // InferOps' committed receipt, and two bindings never send the same key.
    const idempotencyKey = `inferos-${this.#bindingId()}-${actionId}`;
    this.ctx.storage.kv.put(`${PENDING_PREFIX}${actionId}`, { locationId, expectedRevision, idempotencyKey });
    return actionId;
  }

  @skipRpcValidation()
  async applyAction(actionId: number, _cache?: unknown): Promise<void> {
    const pending = this.ctx.storage.kv.get<PendingReview>(`${PENDING_PREFIX}${actionId}`);
    if (!pending) throw new Error(`Unknown action: ${actionId}`);
    await this.#call(`/project/locations/${pending.locationId}/review-request`, value => value, {
      method: "POST", idempotencyKey: pending.idempotencyKey, body: { expectedRevision: pending.expectedRevision },
    });
    this.ctx.storage.kv.delete(`${PENDING_PREFIX}${actionId}`);
  }

  async rejectAction(actionId: number): Promise<void> {
    this.ctx.storage.kv.delete(`${PENDING_PREFIX}${actionId}`);
  }

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: boolean }> {
    return { message: "A requested review can't be withdrawn from InferOS.", canRetry: false };
  }

  readonly #verifyObserverAccess = observerAccessVerifier({
    hasCollectionAccess: async (verifier: Fetcher<OperationsVerifierApi>, subresources) =>
      verifier.canReadAll([...subresources]),
  });

  async getHistoricalSubresources(): Promise<string[]> {
    return [];
  }

  async verifyObserverAccess(observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
                             subresources: string[]): Promise<{ allowedObserverIds: string[] }> {
    // Only ids of this binding's company and workspace; anything else was never reported here.
    for (const id of subresources) {
      const r = parseReported(id);
      if (r.tenantId !== this.ctx.props.tenantId || r.workspaceId !== this.ctx.props.workspaceId) {
        throw new Error("This connection was asked about a resource it never reports.");
      }
    }
    return this.#verifyObserverAccess(observers, subresources);
  }

  async addObserver(_id: string, _verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}
}

/** What a session may do through its facet. */
type FacetAccess = {
  props: ProjectProps;
  call<T>(path: string, parse: (value: unknown) => T,
          options?: { method?: "GET" | "POST"; idempotencyKey?: string; body?: unknown }): Promise<T>;
  pendingReviews(): Map<string, PendingReview>;
  queueReview(locationId: string, expectedRevision: string): number;
  subscribe(queue: RpcStub<ApprovalQueue>, hook: RpcStub<ProjectEventHookTarget>): Promise<void>;
};

/** What a read reports: required, so no observation can leave its subresources out. */
type Observation = ObservationDescription & { subresources: string[] };

class ProjectSessionImpl extends RpcTarget implements ProjectSession {
  readonly #queue: RpcStub<ApprovalQueue>;
  readonly #gk: FacetAccess;

  constructor(queue: RpcStub<ApprovalQueue>, gk: FacetAccess) {
    super();
    this.#queue = queue;
    this.#gk = gk;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }

  get #props(): ProjectProps {
    return this.#gk.props;
  }

  async #observe(observation: Observation): Promise<void> {
    await this.#queue.authorizeObservation(observation);
  }

  #project(): string {
    return projectSubresource(this.#props);
  }

  /** A Location as read, with any pending request shown as requested (simulation). */
  #simulated(location: LocationRecord): Location {
    const pending = this.#gk.pendingReviews().has(location.ref.id);
    return pending ? { ...location, review: { status: "requested" } } : location;
  }

  async getProject(): Promise<Project> {
    const project: ProjectRecord = await this.#gk.call(`/project/projects/${this.#props.projectId}`, projectOf);
    await this.#observe({
      title: "Read an InferOps Project",
      description: `Read Project ${project.key}.`,
      containsRestrictedData: true,
      subresources: [this.#project()],
    });
    return project;
  }

  async listLocations(options?: { cursor?: string; limit?: number }): Promise<LocationPage> {
    const limit = Math.min(100, Math.max(1, Math.trunc(options?.limit ?? 50)));
    const query = new URLSearchParams({ project: this.#props.projectId, limit: String(limit) });
    if (options?.cursor) query.set("cursor", options.cursor);
    const page = await this.#gk.call(`/project/locations?${query}`, locationPageOf);
    // Only this Project's Locations, whatever came back.
    const items = page.items.filter(l => l.project.id === this.#props.projectId).map(l => this.#simulated(l));
    await this.#observe({
      title: "Listed InferOps Locations",
      description: `Listed ${items.length} Location${items.length === 1 ? "" : "s"} of the Project.`,
      containsRestrictedData: true,
      subresources: [this.#project(), ...items.map(l => locationSubresource(this.#props, l.ref.id))],
    });
    return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async getLocation(locationId: string): Promise<Location> {
    const id = locationId.toLowerCase();
    if (!UUID.test(id)) throw named("NotFound", "Not found.");
    const location = await this.#gk.call(`/project/locations/${id}`, locationOf);
    // A Location of another Project is not this binding's: the same answer as one that doesn't exist.
    if (location.project.id !== this.#props.projectId) throw named("NotFound", "Not found.");
    const shown = this.#simulated(location);
    await this.#observe({
      title: "Read an InferOps Location",
      description: `Read Location ${location.name}.`,
      containsRestrictedData: true,
      subresources: [this.#project(), locationSubresource(this.#props, id)],
    });
    return shown;
  }

  async requestReview(locationId: string, expectedRevision: string): Promise<void> {
    const id = locationId.toLowerCase();
    if (!UUID.test(id)) throw named("NotFound", "Not found.");
    if (!/^(0|[1-9][0-9]{0,19})$/.test(expectedRevision)) throw new Error("expectedRevision must be a revision you read.");
    // Confirms the Location is this Project's before asking; a read for the action, not an observation.
    const location = await this.#gk.call(`/project/locations/${id}`, locationOf);
    if (location.project.id !== this.#props.projectId) throw named("NotFound", "Not found.");
    const actionId = this.#gk.queueReview(id, expectedRevision);
    await this.#queue.submitAction(actionId, {
      title: "Request a Location review",
      description: `Request a review of Location ${location.name} (revision ${expectedRevision}).`,
      implementsRevert: false,
      actionKind: REQUEST_REVIEW_KIND,
      // A request, not an approval: none of the opt-out rules applies, and InferOps checks
      // location:write and location:read itself.
      autoApprovable: true,
    });
  }

  async subscribe(hook: RpcStub<ProjectEventHookTarget>): Promise<void> {
    await this.#gk.subscribe(this.#queue, hook);
  }
}

/** What a delivery drops instead of disclosing: the person can't read it now, or isn't connected. */
const UNDISCLOSED = new Set(["NotFound", "Forbidden", "ConnectionExpired"]);

/**
 * A hook's delivery (FAC-236): the binding's facet, which hands an event to one firing only if it
 * is this binding's company and workspace, the Location is this Project's, and the connected person
 * can read it now with their own token. The firing's approval queue authorizes the observation
 * and backs the Project session the hook receives.
 */
@validateRpc()
class ProjectEventDeliveryImpl extends RpcTarget implements ProjectEventDelivery {
  readonly #gk: FacetAccess;

  constructor(gk: FacetAccess) {
    super();
    this.#gk = gk;
  }

  async deliver(callback: RpcStub<ProjectEventHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
                event: StoredEvent): Promise<void> {
    const p = this.#gk.props;
    if (event.tenantId !== p.tenantId || event.workspaceId !== p.workspaceId) return;
    let location: LocationRecord;
    try {
      // Admission now, as the person: never the platform's delivery, never an earlier read.
      location = await this.#gk.call(`/project/locations/${event.locationId}`, locationOf);
    } catch (error) {
      if (UNDISCLOSED.has((error as Error).name)) return;
      throw error;
    }
    if (location.project.id !== p.projectId) return;
    await approvalQueue.authorizeObservation({
      title: "Received an InferOps event",
      description: `A review was requested for Location ${location.name}.`,
      containsRestrictedData: true,
      subresources: [projectSubresource(p), locationSubresource(p, location.ref.id)],
    });
    // Owns its queue: released when receiveEvent() returns.
    using project = new ProjectSessionImpl(approvalQueue.dup(), this.#gk);
    const pending = this.#gk.pendingReviews().has(location.ref.id);
    await callback.receiveEvent({
      eventId: event.eventId, type: event.type, occurredAt: event.occurredAt,
      workspaceId: event.workspaceId,
      location: pending ? { ...location, review: { status: "requested" } } : location,
      revision: event.revision, project,
    } satisfies ProjectEvent);
  }
}

// ── Attention authority (FAC-237) ──────────────────────────────────────────────────────────────

type AttentionTarget = { v: 1; tenantId: string; kind: string; id: string };
type AttentionIntent = {
  target: AttentionTarget;
  audience: { kind: "permission-holders"; workspaceId: string; permission: string };
  reason: string;
  sourceEventId: string;
};

/** The committed event InferOps records for each attention reason this authority can confirm. */
const EVENT_TYPE_FOR_REASON: Record<string, string> = {
  review_requested: "project.location.review_requested",
};

/** The committed-event fields verifyEvent compares, read field by field from InferOps' answer. */
function committedEventOf(body: unknown): {
  eventId: string; type: string; tenantId: string; workspaceId: string;
  resource: { tenantId: string; kind: string; id: string };
} {
  const e = body as Record<string, unknown> | null;
  const r = e?.resource as Record<string, unknown> | undefined;
  const fields = [e?.eventId, e?.type, e?.tenantId, e?.workspaceId, r?.tenantId, r?.kind, r?.id];
  // A malformed answer is not a "no": InferOps said something this can't read, so it throws.
  if (!fields.every(f => typeof f === "string")) throw new Error("InferOps answered an unreadable event");
  return {
    eventId: e!.eventId as string, type: e!.type as string, tenantId: e!.tenantId as string,
    workspaceId: e!.workspaceId as string,
    resource: { tenantId: r!.tenantId as string, kind: r!.kind as string, id: r!.id as string },
  };
}

/** The InferOps read for a target this authority can label: a Project or a Location of this company. */
function recordPath(target: AttentionTarget, tenantId: string): string | null {
  const id = target.id.toLowerCase();
  if (target.tenantId.toLowerCase() !== tenantId || !UUID.test(id)) return null;
  if (target.kind === "project/location") return `/project/locations/${id}`;
  if (target.kind === "project/project") return `/project/projects/${id}`;
  return null;
}

/**
 * A Project's or Location's name, from InferOps' answer. An answer without a usable name is
 * unreadable and throws: not a string, or nothing visible in it (`visibleName`), which the host
 * would show as null and so read as "gone".
 */
function nameOf(body: unknown): string {
  const name = (body as { name?: unknown } | null)?.name;
  if (typeof name !== "string" || !visibleName(name)) throw new Error("InferOps answered an unreadable record");
  return name;
}

/** How many targets `describe` reads at once, so one Home load can't flood InferOps. */
const DESCRIBE_CONCURRENCY = 8;

/** `fn` over `items` with at most `limit` running at once; results in input order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Who may see an attention target, answered with each person's OWN connection, live. A person
 * without a connection, or whose InferOps access refuses, sees nothing. An answer InferOps can't
 * give (an outage, an ended session) throws, so nothing is delivered on a guess.
 */
@validateRpc()
export class InferLabAttentionAuthority extends WorkerEntrypoint<Cloudflare.Env> {
  async #account(subject: GatekeeperSubject): Promise<DurableObjectStub<OperationsAccount> | null> {
    const index = this.ctx.exports.SubjectIndex.get(this.ctx.exports.SubjectIndex.idFromName(subjectIndexName(subject)));
    const accountId = await index.account();
    return accountId ? accountStub(this.ctx, accountId) : null;
  }

  async #sees(account: DurableObjectStub<OperationsAccount>, target: AttentionTarget, workspaceId: string): Promise<boolean> {
    const config = configOrThrow(this.env);
    if (target.tenantId.toLowerCase() !== config.tenantId || !UUID.test(target.id.toLowerCase())) return false;
    if (target.kind === "project/project") return account.canRead(`/project/projects/${target.id}`, workspaceId);
    if (target.kind === "project/location") return account.canRead(`/project/locations/${target.id}`, workspaceId);
    // Other kinds have no InferOps check here yet: nobody sees them.
    return false;
  }

  @skipRpcValidation()
  async approves(workspace: { workspaceId: string; owner: GatekeeperSubject }, intent: AttentionIntent): Promise<boolean> {
    const config = configOrThrow(this.env);
    if (intent.target.tenantId.toLowerCase() !== config.tenantId) return false;
    const owner = await this.#account(workspace.owner);
    if (!owner) return false;
    const company = await owner.company();
    if (!company.workspaces.some(w => w.id === intent.audience.workspaceId.toLowerCase())) return false;
    return this.#sees(owner, intent.target, intent.audience.workspaceId.toLowerCase());
  }

  /**
   * The label for each of `targets` that `subject` can see now, read with their OWN connection: the
   * Project's or Location's name, or null when they have no connection, can't see it in any of
   * their workspaces (403/404), or the kind has no label here. Same length and order. An answer
   * InferOps can't give (an outage, an ended session, an unreadable record) throws, so a failure is
   * never shown as "no longer available". One company read per call; each target is tried in the
   * person's workspaces in turn, since a target carries no workspace, with at most
   * DESCRIBE_CONCURRENCY targets read at once.
   */
  @skipRpcValidation()
  async describe(subject: GatekeeperSubject, targets: AttentionTarget[]): Promise<(string | null)[]> {
    const account = await this.#account(subject);
    if (!account) return targets.map(() => null);
    const config = configOrThrow(this.env);
    const company = await account.company();
    return mapLimited(targets, DESCRIBE_CONCURRENCY, async target => {
      const path = recordPath(target, config.tenantId);
      if (!path) return null;
      for (const w of company.workspaces) {
        const body = await account.readIfVisible(path, w.id);
        if (body !== null) return nameOf(body);
      }
      return null;
    });
  }

  /**
   * Where `subject` opens `target`: the InferWork link InferLab's own resolver builds
   * (`resource.resolve`, destination `page`), asked with their OWN connection for the target's
   * address in each of their workspaces in turn. Null when they have no connection or no workspace
   * of theirs resolves it (403/404); throws when InferOps can't answer. Never a URL from the item:
   * only the resolver's `href`, which the host then checks against its InferWork origins. A record
   * lives in exactly one workspace, so the first workspace that resolves it is the only one.
   */
  @skipRpcValidation()
  async open(subject: GatekeeperSubject, target: AttentionTarget): Promise<{ url: string } | null> {
    const account = await this.#account(subject);
    if (!account) return null;
    const config = configOrThrow(this.env);
    if (!recordPath(target, config.tenantId)) return null;
    const company = await account.company();
    for (const w of company.workspaces) {
      const address = `inferops://${company.slug}.${w.slug}/${target.kind}/${target.id.toLowerCase()}`;
      const body = await account.readIfVisible(
        `/resources/resolve?address=${encodeURIComponent(address)}&destination=page`, w.id);
      if (body === null) continue;
      const href = (body as { href?: unknown } | null)?.href;
      if (typeof href !== "string" || href === "") throw new Error("InferOps answered an unreadable resolution");
      return { url: href };
    }
    return null;
  }

  /**
   * Whether `intent.sourceEventId` is a COMMITTED InferOps event that matches the intent: read with
   * the workspace OWNER's own connection, so a workspace can cite only events its owner may see.
   * True only when it exists and its resource is `intent.target`, its type is the one for
   * `intent.reason`, its workspace is the audience's and its company is this deployment's. Not
   * found or any mismatch is false; an answer InferOps can't give throws.
   */
  @skipRpcValidation()
  async verifyEvent(workspace: { workspaceId: string; owner: GatekeeperSubject }, intent: AttentionIntent): Promise<boolean> {
    const config = configOrThrow(this.env);
    const target = intent.target;
    const expectedType = EVENT_TYPE_FOR_REASON[intent.reason];
    const workspaceId = intent.audience.workspaceId.toLowerCase();
    const eventId = intent.sourceEventId.toLowerCase();
    if (!expectedType || target.kind !== "project/location") return false;
    if (target.tenantId.toLowerCase() !== config.tenantId) return false;
    if (!UUID.test(target.id.toLowerCase()) || !UUID.test(eventId) || !UUID.test(workspaceId)) return false;
    const owner = await this.#account(workspace.owner);
    if (!owner) return false;
    const body = await owner.readIfVisible(`/project/locations/${target.id.toLowerCase()}/events/${eventId}`, workspaceId);
    if (body === null) return false;
    const event = committedEventOf(body);
    return event.eventId.toLowerCase() === eventId
      && event.type === expectedType
      && event.tenantId.toLowerCase() === config.tenantId
      && event.workspaceId.toLowerCase() === workspaceId
      && event.resource.tenantId.toLowerCase() === target.tenantId.toLowerCase()
      && event.resource.kind === target.kind
      && event.resource.id.toLowerCase() === target.id.toLowerCase();
  }

  @skipRpcValidation()
  async eligible(intent: AttentionIntent, candidates: GatekeeperSubject[]): Promise<GatekeeperSubject[]> {
    const workspaceId = intent.audience.workspaceId.toLowerCase();
    const verdicts = await Promise.all(candidates.map(async candidate => {
      const account = await this.#account(candidate);
      if (!account) return false;
      if (!await account.holds(intent.audience.permission, workspaceId)) return false;
      return this.#sees(account, intent.target, workspaceId);
    }));
    return candidates.filter((_, i) => verdicts[i]);
  }

  @skipRpcValidation()
  async visible(subject: GatekeeperSubject, targets: AttentionTarget[]): Promise<boolean[]> {
    const account = await this.#account(subject);
    if (!account) return targets.map(() => false);
    const company = await account.company();
    return Promise.all(targets.map(async target => {
      // The target's own workspace isn't on it: try the person's workspaces, any yes is a yes.
      for (const w of company.workspaces) {
        try {
          if (await this.#sees(account, target, w.id)) return true;
        } catch (error) {
          if (!isDefiniteNo(error)) throw error;
        }
      }
      return false;
    }));
  }
}

// ── Browser legs ───────────────────────────────────────────────────────────────────────────────

function attemptFor(ctx: ExecutionContext, attemptId: string): DurableObjectStub<ConnectAttempt> | null {
  if (!HEX_64.test(attemptId)) return null;
  try {
    return ctx.exports.ConnectAttempt.get(ctx.exports.ConnectAttempt.idFromString(attemptId));
  } catch {
    return null;
  }
}

const invalidLink = () => htmlResponse(INVALID_LINK_HTML, 400);
const CALLBACK_PARAMS = ["state", "code", "error"] as const;

function parseState(state: string): { attemptId: string; oauthNonce: string } | null {
  const [attemptId, oauthNonce, extra] = state.split(".");
  if (extra !== undefined || !attemptId || !oauthNonce || !HEX_64.test(oauthNonce)) return null;
  return { attemptId, oauthNonce };
}

export default {
  /**
   * The two browser legs under BASE_URL: `/<attempt>/<nonce>` sends the browser to InferLab's
   * `/authorize`, and `/oauth` is the exact redirect URI InferOps registered.
   */
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    // InferOps' committed events (FAC-236): `POST <BASE_URL>/events/<key>`, signed, no browser.
    const events = new URL(request.url).pathname.split("/");
    const eventsPrefix = `${GATEKEEPER_PATH}/${EVENTS_PATH}`.split("/");
    if (events.length === eventsPrefix.length + 1 && eventsPrefix.every((segment, i) => events[i] === segment)) {
      const key = events.at(-1)!;
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      if (!DESTINATION_KEY.test(key)) return new Response(null, { status: 404 });
      return handleEventDelivery(request, env, ctx.exports, key);
    }
    const config = readConfig(env);
    if ("off" in config) {
      return htmlResponse(errorPageHtml("InferLab operations is not configured", config.off), 503);
    }
    const url = new URL(request.url);
    const prefix = new URL(config.baseUrl).pathname;
    if (request.method !== "GET" || !url.pathname.startsWith(`${prefix}/`)) {
      return new Response("Not Found", { status: 404 });
    }
    const segments = url.pathname.slice(prefix.length + 1).split("/");

    if (segments.length === 2 && HEX_64.test(segments[1]!) && segments[1]!.length === NONCE_BYTES * 2) {
      const stub = attemptFor(ctx, segments[0]!);
      if (!stub) return invalidLink();
      const redirectUri = redirectUriFor(config);
      const begun = await stub.begin(segments[1]!, redirectUri);
      if (!begun) return invalidLink();
      const authorize = new URL("/authorize", config.origin);
      authorize.searchParams.set("client_id", INFERLAB_CLIENT_ID);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("state", `${segments[0]}.${begun.oauthNonce}`);
      authorize.searchParams.set("code_challenge", begun.codeChallenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      // The account chooser stays: the person picks which account (and company) to connect.
      authorize.searchParams.set("prompt", "select_account");
      return Response.redirect(authorize.toString(), 302);
    }

    if (segments.length === 1 && segments[0] === "oauth") {
      if (CALLBACK_PARAMS.some(name => url.searchParams.getAll(name).length > 1)) {
        for (const state of url.searchParams.getAll("state")) {
          const parsed = parseState(state);
          if (parsed) await attemptFor(ctx, parsed.attemptId)?.abandon(parsed.oauthNonce);
        }
        return invalidLink();
      }
      const parsed = parseState(url.searchParams.get("state") ?? "");
      const stub = parsed ? attemptFor(ctx, parsed.attemptId) : null;
      if (!parsed || !stub) return invalidLink();
      if (url.searchParams.has("error")) {
        if (!await stub.abandon(parsed.oauthNonce)) return invalidLink();
        return htmlResponse(errorPageHtml("Connection was not completed",
          "InferLab did not complete the connection. Close this window and try again."), 400);
      }
      const code = url.searchParams.get("code");
      if (!code) return invalidLink();
      const result = await stub.complete(code, parsed.oauthNonce);
      if (!result) return invalidLink();
      if ("error" in result) return htmlResponse(errorPageHtml("Connection failed", result.error), 502);
      return htmlResponse(connectHandoffPageHtml(result.handoff));
    }

    return new Response("Not Found", { status: 404 });
  },
};
