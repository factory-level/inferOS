// Sign in with InferLab: the vendor offers sign-in only when configured, the popup leg redirects to
// InferLab's /authorize with PKCE, and the callback leg exchanges the code once, server-side, and
// hands the Workshop an account carrying the verified email. Signing in connects that account and
// keeps its session (FAC-300); a sign-in first asks InferLab to reuse a live sign-in (`prompt=none`)
// and goes on to an interactive leg when there is none.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { pkceChallenge } from "@gadgets/gatekeeper-kit/oauth-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeFromTokenResponse, handleInferLabLogin, inferLabAuthOrigin, startInferLabLogin,
  verifiedEmail, type LoginPurpose,
} from "../src/inferlab-login.js";
import { companyAdmits, deploymentCompany } from "../src/deployment-company.js";
import { signIns, signInSubjects, type InferLabLogin, type SignInExports } from "./worker.js";

const LOGIN_ENV = {
  INFERLAB_AUTH_ORIGIN: "http://localhost:8080",
  BASE_URL: "http://localhost:8787/gatekeeper/inferops",
};
const REDIRECT_URI = "http://localhost:8787/gatekeeper/inferops/oauth";

afterEach(() => vi.unstubAllGlobals());

/** Runs `body` with the test worker's exports, from inside a throwaway sign-in object. */
async function withExports<R>(body: (exports: SignInExports) => Promise<R>): Promise<R> {
  const stub = env.INFERLAB_LOGIN.get(env.INFERLAB_LOGIN.newUniqueId());
  return runInDurableObject(stub, (_: InferLabLogin, state) =>
    body(state.exports as unknown as SignInExports));
}

/** The Workshop's sign-in: a connect that first asks InferLab to reuse a live sign-in. */
const SIGN_IN: LoginPurpose = { kind: "connect", silent: true };

/** Starts an attempt whose callback records under `label`; returns the popup URL. */
async function start(label: string, purpose: LoginPurpose = SIGN_IN): Promise<string> {
  return withExports(async exports => {
    const callback = exports.TestConnectCallback({ props: { label } });
    return (await startInferLabLogin(env.INFERLAB_LOGIN, LOGIN_ENV, purpose, callback as never)).url;
  });
}

function get(url: string, company?: string): Promise<Response | null> {
  return handleInferLabLogin(new Request(url),
    company === undefined ? LOGIN_ENV : { ...LOGIN_ENV, INFEROPS_COMPANY: company }, env.INFERLAB_LOGIN);
}

/** Follows the popup URL to InferLab; returns the authorize request's parameters. */
async function authorize(label: string, purpose: LoginPurpose = SIGN_IN): Promise<URLSearchParams> {
  const response = await get(await start(label, purpose));
  expect(response?.status).toBe(302);
  const location = new URL(response!.headers.get("Location")!);
  expect(`${location.origin}${location.pathname}`).toBe("http://localhost:8080/authorize");
  return location.searchParams;
}

type TokenRequest = { clientId: string; code: string; codeVerifier: string; redirectUri: string };

/**
 * Stubs InferLab: the token endpoint answers with `reply`, recording each exchange it is asked for;
 * `/auth/logout` is recorded in `logouts` and always succeeds; InferOps' `GET /workspaces` lists
 * the one workspace `user` reports.
 */
function tokenEndpoint(reply: (request: TokenRequest) => Response) {
  const requests: Array<{ url: string; body: TokenRequest }> = [];
  const logouts: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/auth/logout")) {
      logouts.push((JSON.parse(String(init.body)) as { refreshToken: string }).refreshToken);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/workspaces")) {
      return Response.json([{
        id: "90000000-0000-4000-8000-000000000001", tenant_id: "t1", product: "inferops", name: "Ops", slug: "ops",
      }]);
    }
    const body = JSON.parse(String(init.body)) as TokenRequest;
    requests.push({ url, body });
    return reply(body);
  });
  return Object.assign(requests, { logouts });
}

const user = (email: string, emailVerified: unknown = true) => ({
  id: "u1", email, emailVerified, name: "Ada", tenantId: "t1",
  workspaces: [{
    workspaceId: "90000000-0000-4000-8000-000000000001", workspaceName: "Ops", product: "inferops",
    role: "owner", deniedPermissions: [],
  }],
});

const signedIn = (email: string) => () => Response.json({
  token: "access", refreshToken: "refresh", user: user(email),
});

describe("configuration", () => {
  it("offers sign-in only for a bare HTTPS origin, or HTTP on loopback", () => {
    expect(inferLabAuthOrigin({})).toBeNull();
    expect(inferLabAuthOrigin({ INFERLAB_AUTH_ORIGIN: " " })).toBeNull();
    expect(inferLabAuthOrigin({ INFERLAB_AUTH_ORIGIN: "https://auth.inferlab.io" }))
      .toBe("https://auth.inferlab.io");
    expect(inferLabAuthOrigin({ INFERLAB_AUTH_ORIGIN: "https://auth.inferlab.io/" }))
      .toBe("https://auth.inferlab.io");
    expect(inferLabAuthOrigin({ INFERLAB_AUTH_ORIGIN: "http://localhost:8080" }))
      .toBe("http://localhost:8080");
    for (const bad of [
      "http://auth.inferlab.io", "https://auth.inferlab.io/sso", "https://u:p@auth.inferlab.io",
      "https://auth.inferlab.io?x=1", "ftp://auth.inferlab.io", "not a url",
    ]) {
      expect(inferLabAuthOrigin({ INFERLAB_AUTH_ORIGIN: bad }), bad).toBeNull();
    }
  });

  it("describes the vendor as a sign-in provider whose accounts are connected, not provided", async () => {
    await withExports(async exports => {
      const vendor = exports.GatekeeperVendor({});
      expect(await vendor.describe()).toMatchObject({ providesAuth: true, autoProvisionsAccount: false });
      const callback = exports.TestConnectCallback({ props: { label: "full" } });
      const { url } = await vendor.connectAccount(callback as never, { scopes: "auth" });
      expect(url).toMatch(/^http:\/\/localhost:8787\/gatekeeper\/inferops\/[0-9a-f]{64}\/[0-9a-f]{64}$/);
    });
  });
});

describe("token response", () => {
  const envelope = (u: unknown) => JSON.stringify({ token: "a", refreshToken: "r", user: u });

  it("normalizes the email, keeps the session and the InferOps and InferMind workspaces only", () => {
    const exchange = exchangeFromTokenResponse(envelope({
      ...user(" Ada@Example.com "),
      workspaces: [
        ...user("x").workspaces,
        { workspaceId: "90000000-0000-4000-8000-000000000002", workspaceName: "Mind", product: "infermind" },
        { workspaceId: "90000000-0000-4000-8000-000000000003", workspaceName: "Other", product: "inferfuture" },
      ],
    }));
    expect(exchange).toEqual({
      grant: { accessToken: "a", accessExpiresAt: 0, refreshToken: "r" },
      identity: {
        userId: "u1", email: "ada@example.com", tenantId: "t1",
        // An InferOps workspace carries no product (as identities stored before InferMind did).
        workspaces: [
          { workspaceId: "90000000-0000-4000-8000-000000000001", workspaceName: "Ops" },
          { workspaceId: "90000000-0000-4000-8000-000000000002", workspaceName: "Mind", product: "infermind" },
        ],
      },
      emailVerified: true,
    });
    expect(verifiedEmail(exchange)).toBe("ada@example.com");
  });

  it("refuses an unreadable or incomplete response", () => {
    for (const body of [
      "{", "null", "{}", envelope({ ...user("x"), email: "" }), envelope({ ...user("x"), email: "no-at-sign" }),
      envelope({ ...user("x"), id: "" }), envelope({ ...user("x"), tenantId: undefined }),
      JSON.stringify({ token: "", refreshToken: "r", user: user("a@b.c") }),
      JSON.stringify({ token: "a", user: user("a@b.c") }),
      envelope({ ...user("x"), workspaces: [{ workspaceId: "not-a-uuid", product: "inferops" }] }),
    ]) {
      expect(() => exchangeFromTokenResponse(body), body).toThrow();
    }
  });

  it("vouches for the email only when InferLab marked it verified", () => {
    for (const flag of [false, null, "true", 1]) {
      expect(() => verifiedEmail(exchangeFromTokenResponse(envelope(user("a@b.c", flag)))), String(flag))
        .toThrow("no verified email");
    }
    const { emailVerified: _omitted, ...unmarked } = user("a@b.c");
    expect(() => verifiedEmail(exchangeFromTokenResponse(envelope(unmarked)))).toThrow("no verified email");
  });
});

describe("sign-in flow", () => {
  it("redirects to /authorize as the inferos public client with an S256 challenge", async () => {
    const params = await authorize("redirect");

    expect(params.get("client_id")).toBe("inferos");
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(params.get("code_challenge_method")).toBe("S256");
    // A sign-in first asks InferLab to reuse a live sign-in in the browser, without any page.
    expect(params.get("prompt")).toBe("none");
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("state")).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
  });

  it("asks for the account chooser for another account, after a sign-out, and on a Gatekeepers-page connect", async () => {
    expect((await authorize("chooser", { kind: "connect" })).get("prompt")).toBe("select_account");
    expect((await authorize("chooser-false", { kind: "connect", silent: false })).get("prompt"))
      .toBe("select_account");
    await withExports(async exports => {
      const vendor = exports.GatekeeperVendor({});
      const callback = exports.TestConnectCallback({ props: { label: "vendor-chooser" } });
      for (const [options, prompt] of [
        [{ scopes: "full" as const }, "select_account"],
        [{ scopes: "full" as const, chooseAccount: true }, "select_account"],
        [{ scopes: "full" as const, chooseAccount: false }, "none"],
        // The vendor's sign-in connects, so a transient-scope request is a connect too.
        [{ scopes: "auth" as const, chooseAccount: false }, "none"],
      ] as const) {
        const { url } = await vendor.connectAccount(callback as never, options);
        const response = await get(url);
        expect(new URL(response!.headers.get("Location")!).searchParams.get("prompt"), JSON.stringify(options))
          .toBe(prompt);
      }
    });
  });

  it("goes on to an interactive leg with no prompt when InferLab has no live sign-in", async () => {
    const silent = await authorize("login-required");
    const requests = tokenEndpoint(signedIn("ada@example.com"));

    const resumed = await get(`${REDIRECT_URI}?error=login_required&state=${silent.get("state")}`);

    expect(resumed?.status).toBe(302);
    const location = new URL(resumed!.headers.get("Location")!);
    expect(`${location.origin}${location.pathname}`).toBe("http://localhost:8080/authorize");
    const params = location.searchParams;
    expect(params.has("prompt")).toBe(false);
    expect(params.get("client_id")).toBe("inferos");
    expect(params.get("state")).not.toBe(silent.get("state"));
    expect(params.get("state")!.split(".")[0]).toBe(silent.get("state")!.split(".")[0]);
    expect(params.get("code_challenge")).not.toBe(silent.get("code_challenge"));
    // The silent leg's state is spent: neither a replay of the error nor a code under it does anything.
    expect((await get(`${REDIRECT_URI}?error=login_required&state=${silent.get("state")}`))?.status).toBe(400);
    expect((await get(`${REDIRECT_URI}?code=c&state=${silent.get("state")}`))?.status).toBe(400);

    // The interactive leg completes the sign-in with its own verifier.
    const done = await get(`${REDIRECT_URI}?code=c&state=${params.get("state")}`);
    expect(done?.status).toBe(200);
    expect(await pkceChallenge(requests[0].body.codeVerifier)).toBe(params.get("code_challenge"));
    expect(signIns).toContainEqual({ label: "login-required", email: "ada@example.com" });

    // An interactive leg InferLab cannot complete ends the attempt: there is no third leg.
    const second = await authorize("login-required-twice");
    const interactive = new URL((await get(
      `${REDIRECT_URI}?error=login_required&state=${second.get("state")}`))!.headers.get("Location")!).searchParams;
    const ended = await get(`${REDIRECT_URI}?error=login_required&state=${interactive.get("state")}`);
    expect(ended?.status).toBe(400);
    expect(await ended!.text()).toContain("not completed");
  });

  it("ends an attempt that asked for the chooser when InferLab answers login_required", async () => {
    const params = await authorize("chooser-login-required", { kind: "connect" });
    const response = await get(`${REDIRECT_URI}?error=login_required&state=${params.get("state")}`);
    expect(response?.status).toBe(400);
    expect((await get(`${REDIRECT_URI}?code=c&state=${params.get("state")}`))?.status).toBe(400);
  });

  it("exchanges the code once, hands the Workshop the verified email and keeps the session", async () => {
    const params = await authorize("ok");
    const requests = tokenEndpoint(signedIn("ada@example.com"));
    const callbackUrl = `${REDIRECT_URI}?code=the-code&state=${params.get("state")}`;

    const response = await get(callbackUrl);

    expect(response?.status).toBe(200);
    expect(await response!.text()).toContain("ticket-ok");
    expect(signIns).toContainEqual({ label: "ok", email: "ada@example.com" });
    // The Workshop keys the account on the principal behind it (ADR 0019).
    expect(signInSubjects).toContainEqual({ label: "ok", subject: { issuer: "http://localhost:8080", subject: "u1" } });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://localhost:8080/auth/token");
    expect(requests[0].body).toMatchObject(
      { clientId: "inferos", code: "the-code", redirectUri: REDIRECT_URI });
    expect(await pkceChallenge(requests[0].body.codeVerifier)).toBe(params.get("code_challenge"));
    // Signing in connects the account (FAC-300): the InferLab session it opened is kept.
    expect(requests.logouts).toEqual([]);

    // The state is single-use: a replay neither exchanges again nor signs in again.
    expect((await get(callbackUrl))?.status).toBe(400);
    expect(requests).toHaveLength(1);
  });

  it("accepts the popup link only once", async () => {
    const url = await start("once");
    expect((await get(url))?.status).toBe(302);
    expect((await get(url))?.status).toBe(400);
  });

  it("rejects a forged or malformed state without calling InferLab", async () => {
    const params = await authorize("forged");
    const requests = tokenEndpoint(signedIn("mallory@example.com"));
    const [attempt] = params.get("state")!.split(".");

    for (const state of [`${attempt}.${"0".repeat(64)}`, attempt, "x.y", `${attempt}.${"0".repeat(64)}.z`]) {
      expect((await get(`${REDIRECT_URI}?code=c&state=${state}`))?.status, state).toBe(400);
      expect((await get(`${REDIRECT_URI}?error=access_denied&state=${state}`))?.status, state).toBe(400);
    }
    expect(requests).toHaveLength(0);
    expect(signIns.some(s => s.label === "forged")).toBe(false);

    // Guessing wrong did not end the real attempt.
    expect((await get(`${REDIRECT_URI}?code=c&state=${params.get("state")}`))?.status).toBe(200);
    expect(signIns).toContainEqual({ label: "forged", email: "mallory@example.com" });
  });

  it("ends the attempt when InferLab reports an error", async () => {
    const params = await authorize("denied");
    const requests = tokenEndpoint(signedIn("ada@example.com"));
    const state = params.get("state");

    const response = await get(`${REDIRECT_URI}?error=access_denied&state=${state}`);

    expect(response?.status).toBe(400);
    expect(await response!.text()).toContain("not completed");
    expect((await get(`${REDIRECT_URI}?code=c&state=${state}`))?.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("shows a safe error page when InferLab rejects the exchange", async () => {
    const params = await authorize("rejected");
    tokenEndpoint(() => Response.json({ error: "invalid_grant", detail: "secret" }, { status: 400 }));

    const response = await get(`${REDIRECT_URI}?code=c&state=${params.get("state")}`);

    expect(response?.status).toBe(502);
    const html = await response!.text();
    expect(html).toContain("HTTP 400");
    expect(html).not.toContain("secret");
    expect(signIns.some(s => s.label === "rejected")).toBe(false);
  });

  // ADR 0019: the account is keyed on the principal, and the exchange only ever answers for a
  // browser the provider edge authenticated as it (a `kind = 'sso'` root). An email InferLab doesn't
  // vouch for (after an email change, say) is simply not passed on: never a key, never an address.
  it("signs in an account whose email InferLab doesn't vouch for by its principal, passing no email", async () => {
    const params = await authorize("unverified");
    tokenEndpoint(() => Response.json({
      token: "access", refreshToken: "refresh", user: user("ada@example.com", false),
    }));

    const response = await get(`${REDIRECT_URI}?code=c&state=${params.get("state")}`);

    expect(response?.status).toBe(200);
    expect(signIns).toContainEqual({ label: "unverified", email: null });
    expect(signInSubjects).toContainEqual({ label: "unverified", subject: { issuer: "http://localhost:8080", subject: "u1" } });
  });

  it("sends the browser to the authorize origin but exchanges the code at the InferLab origin", async () => {
    const proxied = { ...LOGIN_ENV, INFERLAB_AUTHORIZE_ORIGIN: "http://127.0.0.1:8788" };
    const popup = await handleInferLabLogin(new Request(await start("proxied")), proxied, env.INFERLAB_LOGIN);
    // Straight to /authorize on the proxy, first reusing a live sign-in on that host.
    const location = new URL(popup!.headers.get("Location")!);
    expect(`${location.origin}${location.pathname}`).toBe("http://127.0.0.1:8788/authorize");
    expect(location.searchParams.get("prompt")).toBe("none");
    expect(location.searchParams.get("client_id")).toBe("inferos");
    expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    const exchanges = tokenEndpoint(signedIn("ada@example.com"));
    const done = await handleInferLabLogin(new Request(
      `${REDIRECT_URI}?code=c1&state=${location.searchParams.get("state")}`), proxied, env.INFERLAB_LOGIN);
    expect(done?.status).toBe(200);
    expect(exchanges.map(e => e.url)).toEqual(["http://localhost:8080/auth/token"]);
  });

  it("turns sign-in off when the authorize origin is set but malformed", async () => {
    const response = await handleInferLabLogin(new Request(await start("malformed")),
      { ...LOGIN_ENV, INFERLAB_AUTHORIZE_ORIGIN: "http://auth.dev-os.example" }, env.INFERLAB_LOGIN);
    expect(response?.status).toBe(503);
  });

  it("leaves other paths to the RPC-only 404", async () => {
    expect(await get("http://localhost:8787/gatekeeper/inferops/elsewhere")).toBeNull();
    expect(await handleInferLabLogin(
      new Request(REDIRECT_URI, { method: "POST" }), LOGIN_ENV, env.INFERLAB_LOGIN)).toBeNull();
  });
});

// The deployment belongs to one company (inferops ADR 0009 T6, FAC-160).
describe("deployment company", () => {
  const OWN = "20000000-0000-4000-8000-0000000000aa";
  const OTHER = "20000000-0000-4000-8000-0000000000bb";
  const inCompany = (tenantId: string) => () => Response.json({
    token: "access", refreshToken: "refresh", user: { ...user("ada@example.com"), tenantId },
  });

  it("reads INFEROPS_COMPANY as unset, internal, a tenant id, or malformed", () => {
    expect(deploymentCompany({})).toEqual({ kind: "unset" });
    expect(deploymentCompany({ INFEROPS_COMPANY: " " })).toEqual({ kind: "unset" });
    expect(deploymentCompany({ INFEROPS_COMPANY: "internal" })).toEqual({ kind: "internal" });
    expect(deploymentCompany({ INFEROPS_COMPANY: OWN.toUpperCase() })).toEqual({ kind: "tenant", tenantId: OWN });
    for (const bad of ["acme", "Internal", `${OWN}x`, "*"]) {
      expect(deploymentCompany({ INFEROPS_COMPANY: bad }), bad).toBeNull();
    }
  });

  it("refuses only another company's session, and only when a tenant id is named", () => {
    expect(companyAdmits({ kind: "tenant", tenantId: OWN }, OWN.toUpperCase())).toBe(true);
    expect(companyAdmits({ kind: "tenant", tenantId: OWN }, OTHER)).toBe(false);
    // InferOps alone decides these: it holds the reserved list.
    expect(companyAdmits({ kind: "internal" }, OTHER)).toBe(true);
    expect(companyAdmits({ kind: "unset" }, OTHER)).toBe(true);
  });

  it("signs in a person whose session is in the deployment's company", async () => {
    const params = await authorize("own-company");
    tokenEndpoint(inCompany(OWN));

    const response = await get(`${REDIRECT_URI}?code=c&state=${params.get("state")}`, OWN);

    expect(response?.status).toBe(200);
    expect(signIns).toContainEqual({ label: "own-company", email: "ada@example.com" });
  });

  it("refuses and signs out a session from another company, naming neither", async () => {
    const params = await authorize("other-company");
    const requests = tokenEndpoint(inCompany(OTHER));

    const response = await get(`${REDIRECT_URI}?code=c&state=${params.get("state")}`, OWN);

    expect(response?.status).toBe(502);
    const html = await response!.text();
    expect(html).toContain("belongs to another company");
    expect(html).not.toContain(OWN);
    expect(html).not.toContain(OTHER);
    expect(requests.logouts).toEqual(["refresh"]);
    expect(signIns.some(s => s.label === "other-company")).toBe(false);
  });

  it("shows InferOps' own refusal of another company's session in the same words", async () => {
    const params = await authorize("refused-upstream");
    tokenEndpoint(() => Response.json({ error: "company_not_this_deployment" }, { status: 403 }));

    const response = await get(`${REDIRECT_URI}?code=c&state=${params.get("state")}`, "internal");

    expect(response?.status).toBe(502);
    expect(await response!.text()).toContain("belongs to another company");
    expect(signIns.some(s => s.label === "refused-upstream")).toBe(false);
  });

  it("turns sign-in off, without exchanging the code, when the setting is malformed", async () => {
    const params = await authorize("misconfigured");
    const requests = tokenEndpoint(inCompany(OWN));

    const response = await get(`${REDIRECT_URI}?code=c&state=${params.get("state")}`, "acme");

    expect(response?.status).toBe(502);
    expect(await response!.text()).toContain("INFEROPS_COMPANY");
    expect(requests).toHaveLength(0);
    expect(signIns.some(s => s.label === "misconfigured")).toBe(false);
  });
});
