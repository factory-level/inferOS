// Sign in to InferOS with InferLab (FAC-214): the Workshop's "Sign in with Google" (FAC-300), backed
// by InferLab central-auth's authorization-code + PKCE server, which sends the person on to Google.
// Sign-in only.
//
// - The vendor declares `providesAuth` and `providesSubject`, so the Workshop keys the account on
//   the InferLab subject (issuer = INFERLAB_AUTH_ORIGIN, subject = the principal id), never on email.
// - It refuses any connect but `scopes: "auth"`, lists no resources, and its account exposes no
//   tool, resource or credential: signing in grants nothing. Business access is a separate
//   connection (FAC-235), not this package.
// - One `SignInAttempt` Durable Object per attempt holds the Workshop's callback, the single-use
//   initiation and OAuth nonces (the kit's connect-handshake), and the PKCE verifier, and deletes
//   itself once used or by alarm.
// - The code is exchanged server-side, and a session in another company than INFEROPS_COMPANY is
//   refused. What happens to the session InferLab opened depends on what the Workshop asked for:
//   - A sign-in the Workshop asked to keep (`keepSignIn`, FAC-300; the vendor declares `keepsSignIn`)
//     keeps the session in its `SignInAttempt` object, which then outlives the attempt: the refresh
//     token stays there and nowhere else, and the account the Workshop is handed answers
//     `checkSignIn()` (a refresh, which rotates the token; a 401 is the session's end) and
//     `endSignIn()` (`POST /auth/sign-out`, which ends every central-auth session of the person and
//     every session under them, so every InferLab app is signed out). The Workshop's session is
//     backed by it. The object ends the session itself 30 days after its last confirmation, and when
//     the Workshop revokes a sign-in it did not use.
//   - Any other sign-in ends the session at once, so a Workshop that predates `keepSignIn` is never
//     handed one it would not hold. Only the subject, the company and a vouched email are kept.
// - `/authorize` carries a `prompt`. A kept sign-in asks for `prompt=none` unless the Workshop asked
//   for the account chooser (`chooseAccount`: "Use a different Google account", or the first
//   sign-in after a sign-out): a live central-auth sign-in in the browser then completes the popup
//   with no page, and InferLab's `login_required` (or `interaction_required`, `consent_required`,
//   `account_selection_required`) re-keys the attempt, once, to an interactive leg with no prompt,
//   which goes straight to Google. Every other sign-in asks for `prompt=select_account`.
// - Without a valid INFERLAB_AUTH_ORIGIN and INFEROPS_COMPANY, every attempt fails with a message
//   naming the setting. There is no default issuer, demo company or other fallback.
//
// Ported from the archived fork's custom-gatekeepers/gatekeeper-inferops (24f5d885); see README.md
// for the ledger of what was taken and what was left behind.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  NONCE_KEY, advanceToOAuth, claimOAuth, putInitiation, type StoredNonce,
} from "@gadgets/gatekeeper-kit/connect-handshake";
import {
  INITIATION_NONCE_LIFETIME_MS, NONCE_BYTES, OAUTH_NONCE_LIFETIME_MS, generateNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  INVALID_LINK_HTML, connectHandoffPageHtml, errorPageHtml, htmlResponse,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { createPkce } from "@gadgets/gatekeeper-kit/oauth-client";
import { createLogger } from "@gadgets/observability/logger";
import type {
  AccountDescription, ConnectHandoff, Gatekeeper, GatekeeperConnectCallback, GatekeeperConnectOptions,
  GatekeeperSubject, GatekeeperUser, GatekeeperUserVerifier, GatekeeperVendor as GatekeeperVendorIface,
  ResourceConfiguratorFrame, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { handleInferLabAuthProxy } from "@gadgets/gatekeeper-kit/inferlab-edge";
import { type InferLabConfig, basePathOf, inferLabTarget, readConfig, redirectUriFor } from "./config";
import {
  INFERLAB_CLIENT_ID, KEPT_SIGN_IN_LIFETIME_MS, OTHER_COMPANY, SignInFailure, endSession, exchangeCode,
  refreshSession, signOutEverywhere,
} from "./token";

const logger = createLogger<{ vendorId: string }>({
  component: "gatekeeper.inferlab", vendorId: "inferlab",
});

const CALLBACK_KEY = "callback";
const PURPOSE_KEY = "purpose";
/** The session a kept sign-in holds (FAC-300). */
const KEPT_KEY = "kept";

/** A plain mark, inline so the account needs no asset. */
const INFERLAB_LOGO_URL = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" ' +
  'fill="#4f46e5"/><text x="16" y="22" font-size="16" text-anchor="middle" fill="#fff" ' +
  'font-family="sans-serif">IL</text></svg>');
const HEX_64 = /^[0-9a-f]{64}$/;
/** What every refused action on the sign-in account says. */
const SIGN_IN_ONLY = "An InferLab sign-in grants no access to anything.";

/** What the OAuth stage keeps beside its nonce. `silent`: the leg asked for `prompt=none`. */
type OAuthExtra = { codeVerifier: string; redirectUri: string; silent?: boolean };

/**
 * What a sign-in attempt is for, as the Workshop asked when it started it: `keep` keeps the
 * InferLab session to back the Workshop session (`keepSignIn`), and `silent` first asks InferLab to
 * reuse a sign-in the browser holds (`prompt=none`), for a kept sign-in only.
 */
export type SignInPurpose = { keep: boolean; silent: boolean };

/** A sign-in that keeps nothing and always shows the account chooser. */
const TRANSIENT: SignInPurpose = { keep: false, silent: false };

/** What a kept sign-in holds: the InferLab session's refresh token, never shown to anyone. */
type Kept = { refreshToken: string };

/** The `prompt` an attempt's authorize leg carries; null for the interactive leg after `none`. */
export type Prompt = "none" | "select_account" | null;

/** One authorize leg: its state nonce, PKCE challenge and prompt. */
export type AuthorizeLeg = { oauthNonce: string; codeChallenge: string; prompt: Prompt };

/**
 * The `error` answers to a `prompt=none` leg that mean only that InferLab needs a page (OpenID
 * Connect Core 3.1.2.6): the attempt goes on to an interactive leg instead of ending.
 */
const NEEDS_INTERACTION = new Set(["login_required", "interaction_required", "consent_required",
                                   "account_selection_required"]);

/** The deployment's config, or a thrown error naming the setting that turns sign-in off. */
function configOrThrow(env: Cloudflare.Env): InferLabConfig {
  const config = readConfig(env);
  if ("off" in config) {
    logger.error("InferLab sign-in is not configured", { event: "inferlab.signin.not_configured" });
    throw new Error(config.off);
  }
  return config;
}

/**
 * One attempt: the Workshop's callback, what it is for, the handshake nonces and the PKCE verifier.
 * Deleted once used or expired, unless it keeps its sign-in (FAC-300): it then holds that
 * InferLab session, and only that, for as long as the session lives (KEPT_SIGN_IN_LIFETIME_MS after
 * its last confirmation, renewed by each). A wrong nonce leaves the attempt alone, so only the
 * browser holding the real one can end it.
 */
@validateRpc()
export class SignInAttempt extends DurableObject<Cloudflare.Env> {
  /** The refresh in flight, shared by every concurrent check: a refresh rotates the token. */
  #refreshing: Promise<boolean> | undefined;

  /**
   * Records the Workshop's callback, what the attempt is for, and the initiation nonce the sign-in
   * link carries.
   */
  @skipRpcValidation()
  async start(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
              purpose: SignInPurpose = TRANSIENT): Promise<void> {
    const now = Date.now();
    this.ctx.storage.kv.put(CALLBACK_KEY, callback);
    this.ctx.storage.kv.put<SignInPurpose>(PURPOSE_KEY, purpose);
    putInitiation(this.ctx.storage.kv, initiationNonce, now);
    await this.ctx.storage.setAlarm(now + INITIATION_NONCE_LIFETIME_MS + OAUTH_NONCE_LIFETIME_MS);
  }

  /**
   * Trades the initiation nonce for the state nonce, PKCE challenge and prompt of the first
   * authorize leg; null when spent or expired.
   */
  async begin(initiationNonce: string, redirectUri: string): Promise<AuthorizeLeg | null> {
    const purpose = this.ctx.storage.kv.get<SignInPurpose>(PURPOSE_KEY) ?? TRANSIENT;
    const silent = purpose.keep && purpose.silent;
    const pkce = await createPkce();
    const oauthNonce = advanceToOAuth<OAuthExtra>(this.ctx.storage.kv, initiationNonce, Date.now(), {
      codeVerifier: pkce.codeVerifier, redirectUri, ...(silent ? { silent: true } : {}),
    });
    if (oauthNonce === null) return null;
    return { oauthNonce, codeChallenge: pkce.codeChallenge, prompt: silent ? "none" : "select_account" };
  }

  /**
   * After InferLab answered a silent leg with an error that means it needs a page
   * (NEEDS_INTERACTION): trades its state nonce, once, for an interactive leg's, with a new PKCE
   * verifier and no prompt. Null, leaving the attempt alone, for anything but a live silent leg.
   */
  async resume(oauthNonce: string, redirectUri: string): Promise<AuthorizeLeg | null> {
    const kv = this.ctx.storage.kv;
    if (kv.get<StoredNonce<OAuthExtra>>(NONCE_KEY)?.silent !== true) return null;
    const now = Date.now();
    if (claimOAuth<OAuthExtra>(kv, oauthNonce, now) === null) return null;
    // The kit's handshake moves to OAuth from an initiation only; this one never leaves the object.
    const bridge = generateNonce();
    putInitiation(kv, bridge, now);
    const pkce = await createPkce();
    const next = advanceToOAuth<OAuthExtra>(kv, bridge, now, { codeVerifier: pkce.codeVerifier, redirectUri });
    if (next === null) return null;
    await this.ctx.storage.setAlarm(now + OAUTH_NONCE_LIFETIME_MS);
    return { oauthNonce: next, codeChallenge: pkce.codeChallenge, prompt: null };
  }

  /** Ends the attempt after InferLab reported an error; false when the state was already spent. */
  async abandon(oauthNonce: string): Promise<boolean> {
    if (claimOAuth(this.ctx.storage.kv, oauthNonce, Date.now()) === null) return false;
    await this.#forget();
    return true;
  }

  /**
   * Exchanges the code and hands the Workshop a sign-in account. Null when the state is unknown,
   * spent or expired; `{ error }` with a message safe to show when the sign-in fails.
   */
  async complete(code: string, oauthNonce: string)
      : Promise<{ handoff: ConnectHandoff } | { error: string } | null> {
    const flow = claimOAuth<OAuthExtra>(this.ctx.storage.kv, oauthNonce, Date.now());
    if (flow === null) return null;
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>(CALLBACK_KEY);
    const keep = (this.ctx.storage.kv.get<SignInPurpose>(PURPOSE_KEY) ?? TRANSIENT).keep;
    let kept = false;
    try {
      if (!callback) return null;
      const config = readConfig(this.env);
      if ("off" in config) return { error: config.off };
      // The redirect URI is the one the authorize request named, so a change of BASE_URL mid-flow
      // can't make the exchange name another.
      const signedIn = await exchangeCode(inferLabTarget(config), code, flow.codeVerifier, flow.redirectUri);
      // A sign-in kept for the Workshop session holds the InferLab session from here on; any other
      // keeps none, whatever happens next.
      if (keep && signedIn.tenantId === config.tenantId) {
        this.ctx.storage.kv.put<Kept>(KEPT_KEY, { refreshToken: signedIn.refreshToken });
        kept = true;
      } else if (!await endSession(inferLabTarget(config), signedIn.refreshToken)) {
        logger.warn("InferLab logout failed", { event: "inferlab.signin.logout_failed" });
      }
      if (signedIn.tenantId !== config.tenantId) {
        logger.warn("InferLab session from another company refused", {
          event: "inferlab.signin.other_company",
        });
        throw new SignInFailure(OTHER_COMPANY);
      }
      const account = this.ctx.exports.InferLabAccount({
        props: {
          subject: signedIn.subject, ...(signedIn.email ? { email: signedIn.email } : {}),
          ...(kept ? { attemptId: this.ctx.id.toString() } : {}),
        },
      }) as unknown as Fetcher<GatekeeperUser>;
      const handoff = await callback.complete(account);
      // A Workshop that could not use the sign-in (signups closed, say) revoked it meanwhile.
      if (kept && this.ctx.storage.kv.get<Kept>(KEPT_KEY)) {
        // The attempt is over; what is left is the kept session, held until it ends.
        this.ctx.storage.kv.delete(CALLBACK_KEY);
        this.ctx.storage.kv.delete(PURPOSE_KEY);
        await this.ctx.storage.setAlarm(Date.now() + KEPT_SIGN_IN_LIFETIME_MS);
      } else {
        kept = false;
      }
      return { handoff };
    } catch (error) {
      if (kept) {
        // Nothing holds the kept session now: end it.
        kept = false;
        await this.#endKept();
      }
      if (error instanceof SignInFailure) return { error: error.message };
      logger.error("InferLab sign-in failed", { event: "inferlab.signin.failed", error });
      return { error: "InferLab sign-in failed. Close this window and try again." };
    } finally {
      if (!kept) await this.#forget();
    }
  }

  /**
   * Whether the kept session is still live, found by refreshing it now, which rotates its refresh
   * token: false once InferLab has refused it (401), after which nothing is held, or when nothing
   * is kept. Any other failure throws and says nothing about the session. Concurrent checks share
   * one refresh, so no refresh token is presented twice.
   */
  async checkSession(): Promise<boolean> {
    if (this.#refreshing) return this.#refreshing;
    const kept = this.ctx.storage.kv.get<Kept>(KEPT_KEY);
    if (!kept) return false;
    const refreshing = (async () => {
      const refreshed = await refreshSession(inferLabTarget(configOrThrow(this.env)), kept.refreshToken);
      if ("ended" in refreshed) {
        await this.#forget();
        return false;
      }
      this.ctx.storage.kv.put<Kept>(KEPT_KEY, { refreshToken: refreshed.refreshToken });
      await this.ctx.storage.setAlarm(Date.now() + KEPT_SIGN_IN_LIFETIME_MS);
      return true;
    })();
    this.#refreshing = refreshing;
    try {
      return await refreshing;
    } finally {
      this.#refreshing = undefined;
    }
  }

  /**
   * Ends the person's InferLab sign-in everywhere with the kept session (`POST /auth/sign-out`),
   * then forgets it. Nothing kept (already ended, or never) is done already. Throws, keeping the
   * session for the alarm to end, when InferLab did not confirm the sign-out.
   */
  async endEverywhere(): Promise<void> {
    await this.#settled();
    const kept = this.ctx.storage.kv.get<Kept>(KEPT_KEY);
    if (!kept) return;
    await signOutEverywhere(inferLabTarget(configOrThrow(this.env)), kept.refreshToken);
    await this.#forget();
  }

  /** Ends the kept session alone (`POST /auth/logout`), for a sign-in the Workshop did not use. */
  async revoke(): Promise<void> {
    await this.#settled();
    await this.#endKept();
  }

  async alarm(): Promise<void> {
    await this.#endKept();
  }

  // Waits out a refresh in flight, so the token read next is the latest.
  async #settled(): Promise<void> {
    await this.#refreshing?.catch(() => {});
  }

  // Ends the kept session, if any, best effort, and forgets everything.
  async #endKept(): Promise<void> {
    const kept = this.ctx.storage.kv.get<Kept>(KEPT_KEY);
    const config = readConfig(this.env);
    if (kept && !("off" in config) && !await endSession(inferLabTarget(config), kept.refreshToken)) {
      logger.warn("InferLab logout of a kept sign-in failed", { event: "inferlab.signin.kept_logout_failed" });
    }
    await this.#forget();
  }

  async #forget(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

/**
 * Who a sign-in named: the subject, and the email only when InferLab vouched for it. `attemptId`
 * names the `SignInAttempt` that keeps the sign-in's InferLab session, for a kept sign-in.
 */
type AccountProps = { subject: GatekeeperSubject; email?: string; attemptId?: string };

/**
 * The account a sign-in hands the Workshop: it answers who the person is and nothing else. It lists
 * no resources and refuses every request for access, credentials or configuration. For a kept
 * sign-in (FAC-300) it also answers whether that sign-in is still live, and ends it everywhere.
 */
@validateRpc()
export class InferLabAccount extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    const name = this.ctx.props.email ?? this.ctx.props.subject.subject;
    return { displayName: name, uniqueName: name, avatar: { url: INFERLAB_LOGO_URL } };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  async getGatekeeperClassFor(_url: string)
      : Promise<{ class: DurableObjectClass<Gatekeeper<never>>; resource: SupportedResource }> {
    throw new Error(SIGN_IN_ONLY);
  }

  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error(SIGN_IN_ONLY);
  }

  /** Ends a kept sign-in's InferLab session, for a sign-in the Workshop did not use. */
  async revoke(): Promise<void> {
    await this.#kept()?.revoke();
  }

  /** Whether the kept sign-in is still live, asked of InferLab now; false for a transient one. */
  async checkSignIn(): Promise<boolean> {
    return await this.#kept()?.checkSession() ?? false;
  }

  /**
   * Ends the person's InferLab sign-in everywhere (`POST /auth/sign-out`): every central-auth
   * session of theirs and every app session under it, the kept one included.
   */
  async endSignIn(): Promise<void> {
    await this.#kept()?.endEverywhere();
  }

  #kept(): DurableObjectStub<SignInAttempt> | null {
    const id = this.ctx.props.attemptId;
    if (!id) return null;
    const namespace = this.ctx.exports.SignInAttempt;
    return namespace.get(namespace.idFromString(id));
  }

  async reconnect(): Promise<{ url: string }> {
    throw new Error(SIGN_IN_ONLY);
  }

  async commitReconnect(_stageId: string): Promise<void> {
    throw new Error(SIGN_IN_ONLY);
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return this.ctx.props.email ?? null;
  }

  async getAuthenticatedSubject(): Promise<GatekeeperSubject | null> {
    return this.ctx.props.subject;
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    throw new Error(SIGN_IN_ONLY);
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    throw new Error(SIGN_IN_ONLY);
  }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "InferLab",
      url: "https://inferlab.dev",
      logo: { url: INFERLAB_LOGO_URL },
      color: "#eef2ff",
      tagline: "Sign in with Google through InferLab",
      description: "Sign in to this InferOS with Google, through the InferLab account of the company " +
        "it belongs to. Signing in grants nothing by itself, and signing out ends the sign-in in " +
        "every InferLab app.",
      providesAuth: true,
      providesSubject: true,
      // One Google sign-in through InferLab central auth (FAC-300): the sign-in can back the
      // Workshop session, and the buttons name no product.
      keepsSignIn: true,
      signInLabel: "Sign in with Google",
      chooseAccountLabel: "Use a different Google account",
    };
  }

  /**
   * Starts a sign-in. Any other kind of connection is refused: this gatekeeper only signs people in.
   * `keepSignIn` keeps the InferLab session to back the Workshop session, and with it
   * `chooseAccount: false` first asks InferLab to reuse a sign-in the browser holds; any other
   * sign-in asks for the account chooser and keeps nothing.
   */
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    if (options?.scopes !== "auth") throw new Error("InferLab connects only to sign you in.");
    const config = configOrThrow(this.env);
    const keep = options.keepSignIn === true;
    const purpose: SignInPurpose = { keep, silent: keep && options.chooseAccount === false };
    const id = this.ctx.exports.SignInAttempt.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.SignInAttempt.get(id).start(callback, nonce, purpose);
    return { url: `${config.baseUrl}/${id.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  /** No resources, so no session types for gadget code. */
  async getTypeScriptTypes(): Promise<string> {
    return "";
  }
}

function attemptFor(ctx: ExecutionContext, attemptId: string): DurableObjectStub<SignInAttempt> | null {
  if (!HEX_64.test(attemptId)) return null;
  try {
    return ctx.exports.SignInAttempt.get(ctx.exports.SignInAttempt.idFromString(attemptId));
  } catch {
    return null;
  }
}

const invalidLink = () => htmlResponse(INVALID_LINK_HTML, 400);

/**
 * The browser's redirect to InferLab's `/authorize` for one leg of attempt `attemptId`, through the
 * dev sign-in proxy when there is one (the code still comes from the issuer). `prompt=none` reuses
 * a live central-auth sign-in without a page; `prompt=select_account` shows InferLab's sign-in page
 * even while the browser holds one, so a person can choose which account (and company) to use; no
 * prompt is the interactive leg after `none`, which InferLab sends straight to Google.
 */
function authorizeRedirect(config: InferLabConfig, attemptId: string, redirectUri: string,
                           leg: AuthorizeLeg): Response {
  const authorize = new URL("/authorize", config.authorizeOrigin ?? config.issuer);
  authorize.searchParams.set("client_id", INFERLAB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", `${attemptId}.${leg.oauthNonce}`);
  authorize.searchParams.set("code_challenge", leg.codeChallenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  if (leg.prompt) authorize.searchParams.set("prompt", leg.prompt);
  return Response.redirect(authorize.toString(), 302);
}

/** The query parameters the OAuth callback reads; each may appear at most once. */
const CALLBACK_PARAMS = ["state", "code", "error"] as const;

/** A callback `state`, `<attempt id>.<oauth nonce>`, or null when it isn't one. */
function parseState(state: string): { attemptId: string; oauthNonce: string } | null {
  const [attemptId, oauthNonce, extra] = state.split(".");
  if (extra !== undefined || !attemptId || !oauthNonce || !HEX_64.test(oauthNonce)) return null;
  return { attemptId, oauthNonce };
}

export default {
  /**
   * The two browser legs under BASE_URL: `/<attempt>/<nonce>` sends the browser to InferLab's
   * `/authorize`, and `/oauth` is the exact redirect URI InferLab registered.
   */
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const config = readConfig(env);
    if ("off" in config) {
      return htmlResponse(errorPageHtml("InferLab sign-in is not configured", config.off), 503);
    }
    // The dev sign-in proxy (FAC-296): a request for INFERLAB_AUTHORIZE_ORIGIN is one of InferLab's
    // own sign-in pages, forwarded with the edge secret. Any other host goes on as before.
    const proxied = await handleInferLabAuthProxy(request, config.authorizeOrigin, inferLabTarget(config));
    if (proxied) return proxied;
    const url = new URL(request.url);
    const prefix = basePathOf(config);
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
      return authorizeRedirect(config, segments[0]!, redirectUri, begun);
    }

    if (segments.length === 1 && segments[0] === "oauth") {
      // Each parameter the callback reads must appear at most once. Otherwise which value wins is
      // URLSearchParams' choice, not InferLab's: refuse, and end any attempt a state value names
      // (abandon succeeds only with the attempt's real nonce, so a forged one ends nothing).
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
      const { oauthNonce } = parsed;
      if (url.searchParams.has("error")) {
        // A silent leg InferLab could not complete without a page goes on, once, to the
        // interactive one.
        if (NEEDS_INTERACTION.has(url.searchParams.get("error") ?? "")) {
          const redirectUri = redirectUriFor(config);
          const resumed = await stub.resume(oauthNonce, redirectUri);
          if (resumed) return authorizeRedirect(config, parsed.attemptId, redirectUri, resumed);
        }
        if (!await stub.abandon(oauthNonce)) return invalidLink();
        return htmlResponse(errorPageHtml("Sign-in was not completed",
          "InferLab did not complete the sign-in. Close this window and try again."), 400);
      }
      const code = url.searchParams.get("code");
      if (!code) return invalidLink();
      const result = await stub.complete(code, oauthNonce);
      if (!result) return invalidLink();
      if ("error" in result) return htmlResponse(errorPageHtml("Sign-in failed", result.error), 502);
      return htmlResponse(connectHandoffPageHtml(result.handoff));
    }

    return new Response("Not Found", { status: 404 });
  },
};
