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

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
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
import { type OperationsConfig, readConfig, redirectUriFor } from "./config";
import {
  ConnectFailure, INFERLAB_CLIENT_ID, InferOpsApiError, type LocationRecord, OTHER_COMPANY, type ProjectRecord,
  apiRequest, exchangeCode, locationOf, locationPageOf, logout, projectOf,
} from "./inferops-api";
import type { Location, LocationPage, Project, ProjectSession } from "./types";
import PROJECT_CONFIGURATOR_HTML from "./generated/project-configurator-ui.txt";
import TYPES_CODE from "./types.txt";

export { OperationsAccount, SubjectIndex };

const logger = createLogger<{ vendorId: string }>({ component: "gatekeeper.inferlab-ops", vendorId: VENDOR_ID });

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
    logger.error("InferLab operations is not configured", { event: "inferlab-ops.not_configured" });
    throw new Error(config.off);
  }
  return config;
}

const accountStub = (ctx: { exports: Cloudflare.Exports }, accountId: string) =>
  ctx.exports.OperationsAccount.get(ctx.exports.OperationsAccount.idFromString(accountId));

/** A gadget-facing error with one of the documented names (types.d.ts). */
function named(name: "NotFound" | "Forbidden" | "StaleRevision" | "Conflict" | "ConnectionExpired",
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
        logger.warn("InferLab session from another company refused", { event: "inferlab-ops.other_company" });
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
      logger.error("InferLab operations connect failed", { event: "inferlab-ops.connect_failed", error });
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
    await accountStub(this.ctx, this.ctx.props.accountId).revoke();
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
    return new ProjectSessionImpl(approvalQueue.dup(), {
      props: this.ctx.props,
      call: (path, parse, options) => this.#call(path, parse, options),
      pendingReviews: () => this.#pendingReviews(),
      queueReview: (locationId, expectedRevision) => this.#queueReview(locationId, expectedRevision),
    });
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

  /** Records a review request and returns its action id. */
  #queueReview(locationId: string, expectedRevision: string): number {
    const actionId = (this.ctx.storage.kv.get<number>(NEXT_ACTION_KEY) ?? 0) + 1;
    this.ctx.storage.kv.put(NEXT_ACTION_KEY, actionId);
    // Derived from the action, so a retried apply replays InferOps' committed receipt.
    const idempotencyKey = `inferos-${this.ctx.id.toString().slice(0, 16)}-${actionId}`;
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
}

// ── Attention authority (FAC-237) ──────────────────────────────────────────────────────────────

type AttentionTarget = { v: 1; tenantId: string; kind: string; id: string };
type AttentionIntent = {
  target: AttentionTarget;
  audience: { kind: "permission-holders"; workspaceId: string; permission: string };
};

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
