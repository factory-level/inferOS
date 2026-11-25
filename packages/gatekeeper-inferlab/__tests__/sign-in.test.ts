// FAC-214's auth acceptance suite, gatekeeper half: InferLab sign-in end to end against a fake
// InferLab central-auth (faked at `fetch`, in mock mode: no network, no real provider). The kernel
// half (account keyed on the subject) is packages/workshop-backend/__tests__/subject-login.test.ts.
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type SignInAttempt, type SignInPurpose } from "../src/worker.js";
import {
  ISSUER_MAX_LENGTH, ISSUER_PATTERN, NOT_CONFIGURED, SIGN_IN_CALLBACK_PATH, inferLabTarget, parseOrigin, readConfig,
} from "../src/config.js";
import { KEPT_SIGN_IN_LIFETIME_MS, endSession, exchangeCode } from "../src/token.js";
// The InferLab contract, pinned from inferops (scripts/inferlab-contracts).
import subjectSchema from "../../../scripts/inferlab-contracts/schemas/inferlab.stable-subject.v1.schema.json";

// Vite's static `import.meta.glob` (the source guard below), which this package's worker types don't declare.
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
  }
}

const ISSUER = "http://localhost:23380";
const BASE = "http://localhost:8787/gatekeeper/inferlab";
const REDIRECT_URI = `${BASE}/oauth`;
const COMPANY = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-0000000000f2";
const PRINCIPAL = "00000000-0000-4000-8000-000000000101";

type Seen = { path: string; body: Record<string, unknown> };
let seen: Seen[] = [];
/** What the fake answers `/auth/token` with; a test overrides it. */
let tokenAnswer: () => Response;
/** What the fake answers `/auth/refresh` and `/auth/sign-out` with (FAC-300); a test overrides them. */
let refreshAnswer: () => Response;
let signOutAnswer: () => Response;
let refreshes = 0;

const tokenOk = (user: Record<string, unknown> = {}) => () => Response.json({
  token: "access-token-never-kept",
  refreshToken: "refresh-token-ended-at-once",
  user: { id: PRINCIPAL, email: "Ann@Acme.test", emailVerified: true, tenantId: COMPANY, ...user },
});

beforeEach(() => {
  seen = [];
  tokenAnswer = tokenOk();
  refreshes = 0;
  refreshAnswer = () => Response.json({ token: "access-never-kept", refreshToken: `rotated-${++refreshes}` });
  signOutAnswer = () => new Response(null, { status: 204 });
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.origin !== ISSUER) throw new Error(`unexpected fetch to ${url.origin}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push({ path: url.pathname, body });
    if (url.pathname === "/auth/token") return tokenAnswer();
    if (url.pathname === "/auth/logout") return new Response(null, { status: 204 });
    if (url.pathname === "/auth/refresh") return refreshAnswer();
    if (url.pathname === "/auth/sign-out") return signOutAnswer();
    throw new Error(`unexpected fetch to ${url.pathname}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Env = Parameters<typeof worker.fetch>[1];
const ctx = { exports: { SignInAttempt: env.SIGN_IN_ATTEMPT } } as unknown as Parameters<typeof worker.fetch>[2];
const get = (url: string, e: Partial<Env> = {}) =>
  worker.fetch(new Request(url, { redirect: "manual" }), { ...env, ...e } as Env, ctx);
const hooks = () => env.TEST_HOOKS.getByName("hooks");

let counter = 0;
/** A started attempt, as connectAccount leaves it: its id, its initiation nonce, and a label. */
async function started(purpose?: SignInPurpose, options?: { revokeOnComplete?: boolean }) {
  const attemptId = env.SIGN_IN_ATTEMPT.newUniqueId().toString();
  const nonce = (++counter).toString(16).padStart(64, "a");
  const label = `attempt-${counter}`;
  await hooks().startAttempt(attemptId, nonce, label, purpose, options);
  return { attemptId, nonce, label };
}

/** Follows the sign-in link to InferLab's /authorize and answers its query. */
async function authorize(attemptId: string, nonce: string) {
  const response = await get(`${BASE}/${attemptId}/${nonce}`);
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!);
}

/** The whole flow: link, authorize, callback with a code. */
async function signIn() {
  const attempt = await started();
  const auth = await authorize(attempt.attemptId, attempt.nonce);
  const state = auth.searchParams.get("state")!;
  const callback = await get(`${REDIRECT_URI}?code=the-code&state=${state}`);
  return { ...attempt, auth, state, callback, text: await callback.text() };
}

const sha256base64url = async (text: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

describe("the correct company signs in", () => {
  it("hands the Workshop the InferLab subject, keyed on issuer and principal, with the vouched email", async () => {
    const { label, callback, text } = await signIn();
    expect(callback.status).toBe(200);
    expect(text).toContain("t".repeat(64)); // the handoff page carries the Workshop's ticket
    expect(await hooks().received(label)).toMatchObject({
      subject: { issuer: ISSUER, subject: PRINCIPAL },
      email: "ann@acme.test",
    });
  });

  it("ends the InferLab session at once, so signing in keeps nothing", async () => {
    await signIn();
    expect(seen.map(s => s.path)).toEqual(["/auth/token", "/auth/logout"]);
    expect(seen[1]!.body).toEqual({ refreshToken: "refresh-token-ended-at-once" });
  });

  it("passes no email it wasn't vouched for: the account still signs in by subject", async () => {
    tokenAnswer = tokenOk({ emailVerified: false });
    const { label } = await signIn();
    expect(await hooks().received(label)).toMatchObject({
      subject: { issuer: ISSUER, subject: PRINCIPAL }, email: null,
    });
  });
});

describe("the wrong company is refused", () => {
  it("refuses a session in another company and ends it, without reaching the Workshop", async () => {
    tokenAnswer = tokenOk({ tenantId: OTHER });
    const { label, callback, text } = await signIn();
    expect(callback.status).toBe(502);
    expect(text).toContain("belongs to another company");
    expect(await hooks().received(label)).toBeNull();
    expect(seen.map(s => s.path)).toEqual(["/auth/token", "/auth/logout"]);
  });

  it("refuses when InferOps itself answers that the session is another company's", async () => {
    tokenAnswer = () => Response.json({ error: "company_not_this_deployment" }, { status: 403 });
    const { label, text } = await signIn();
    expect(text).toContain("belongs to another company");
    expect(await hooks().received(label)).toBeNull();
  });
});

describe("login exposes no business tools", () => {
  it("the sign-in account lists no resources and refuses every request for access", async () => {
    const { label } = await signIn();
    const got = await hooks().received(label);
    expect(got?.resources).toBe(0);
    expect(got?.refused).toEqual({
      getVerifier: "An InferLab sign-in grants no access to anything.",
      ensureResources: "An InferLab sign-in grants no access to anything.",
      getGatekeeperClassFor: "An InferLab sign-in grants no access to anything.",
      reconnect: "An InferLab sign-in grants no access to anything.",
    });
  });

  it("the vendor offers sign-in by subject, lists nothing, and refuses any connection but sign-in", async () => {
    const auth = await hooks().vendor("auth");
    expect(auth.description).toMatchObject({ providesAuth: true, providesSubject: true });
    // One Google sign-in (FAC-300): it can back the Workshop session, and no button names a product.
    expect(auth.description).toMatchObject({
      keepsSignIn: true, signInLabel: "Sign in with Google", chooseAccountLabel: "Use a different Google account",
    });
    expect(auth.resources).toBe(0);
    expect(auth.connect).toBe("allowed");
    expect((await hooks().vendor("full")).connect).toBe("InferLab connects only to sign you in.");
    expect((await hooks().vendor(undefined)).connect).toBe("InferLab connects only to sign you in.");
  });

  it("never keeps the access token InferLab issued", async () => {
    const { label } = await signIn();
    expect(JSON.stringify(await hooks().received(label))).not.toContain("access-token");
  });
});

describe("bad config fails closed and loud", () => {
  it.each([
    ["no issuer", { INFERLAB_AUTH_ORIGIN: "" }, NOT_CONFIGURED.issuer],
    ["an issuer with a path", { INFERLAB_AUTH_ORIGIN: `${ISSUER}/auth` }, NOT_CONFIGURED.issuer],
    ["plain http off loopback", { INFERLAB_AUTH_ORIGIN: "http://auth.example.test" }, NOT_CONFIGURED.issuer],
    ["an issuer with credentials", { INFERLAB_AUTH_ORIGIN: "https://u:p@auth.example.test" }, NOT_CONFIGURED.issuer],
    ["no company", { INFEROPS_COMPANY: "" }, NOT_CONFIGURED.company],
    ["a company that isn't a tenant id", { INFEROPS_COMPANY: "acme" }, NOT_CONFIGURED.company],
    ["the old 'internal' company setting", { INFEROPS_COMPANY: "internal" }, NOT_CONFIGURED.company],
    ["an issuer with a trailing-dot host", { INFERLAB_AUTH_ORIGIN: "https://auth.example." }, NOT_CONFIGURED.issuer],
    ["an issuer over 255 characters", { INFERLAB_AUTH_ORIGIN: `https://${"a".repeat(248)}` }, NOT_CONFIGURED.issuer],
    ["no base URL", { BASE_URL: "" }, NOT_CONFIGURED.baseUrl],
    ["a base URL over plain http off loopback", { BASE_URL: "http://os.example.test/gatekeeper/inferlab" }, NOT_CONFIGURED.baseUrl],
    ["a base URL at another gatekeeper's route", { BASE_URL: "http://localhost:8787/gatekeeper/inferops" }, NOT_CONFIGURED.baseUrl],
    ["a base URL below the route", { BASE_URL: "http://localhost:8787/gatekeeper/inferlab/x" }, NOT_CONFIGURED.baseUrl],
    ["a base URL with a query", { BASE_URL: "http://localhost:8787/gatekeeper/inferlab?x=1" }, NOT_CONFIGURED.baseUrl],
  ])("with %s, sign-in can't start, the browser leg says why, and nothing reaches InferLab", async (_why, bad, message) => {
    expect(readConfig({ ...env, ...bad } as Env)).toEqual({ off: message });
    expect((await hooks().vendor("auth", bad)).connect).toBe(message);
    const page = await get(`${BASE}/${"a".repeat(64)}/${"b".repeat(64)}`, bad);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain(message.replaceAll("'", "&#39;").split(":")[0]);
    expect(seen).toEqual([]);
  });

  it("a setting removed mid-flow fails the callback instead of signing in", async () => {
    const attempt = await started();
    const auth = await authorize(attempt.attemptId, attempt.nonce);
    const state = auth.searchParams.get("state")!;
    // The attempt reads its own env; the browser leg with a bad env answers 503 before touching it.
    const page = await get(`${REDIRECT_URI}?code=c&state=${state}`, { INFEROPS_COMPANY: "" });
    expect(page.status).toBe(503);
    expect(await hooks().received(attempt.label)).toBeNull();
  });
});

/** An https origin exactly `length` characters long. */
const originOfLength = (length: number) => `https://${"a".repeat(length - "https://".length)}`;

describe("the callback InferOps registers, and the contract's issuer rule", () => {
  it("builds exactly <BASE_URL>/oauth, at the path InferOps registers for the inferos client", async () => {
    const { auth } = await signIn();
    expect(auth.searchParams.get("redirect_uri")).toBe("http://localhost:8787/gatekeeper/inferlab/oauth");
    // inferops `INFEROS_SIGN_IN_CALLBACK_PATH` (domain/ts/portal/shared/sso.dto.ts), added by
    // factory-level/inferops#2678, merged to develop as 6b8878bb56896aa6490798fb964d094b66c139c2. Its central-auth
    // accepts the `inferos` client only at that exact path, so a change on either side is a
    // cross-repo contract change and must change this literal too.
    expect(SIGN_IN_CALLBACK_PATH).toBe("/gatekeeper/inferlab/oauth");
    expect(new URL(auth.searchParams.get("redirect_uri")!).pathname).toBe(SIGN_IN_CALLBACK_PATH);
  });

  it("applies the pinned contract's issuer pattern and length cap, byte for byte", () => {
    expect(ISSUER_PATTERN.source).toBe(subjectSchema.properties.issuer.pattern);
    expect(ISSUER_MAX_LENGTH).toBe(subjectSchema.properties.issuer.maxLength);
    expect(parseOrigin(originOfLength(255))).toBe(originOfLength(255));
    expect(parseOrigin(originOfLength(256))).toBeNull();
    expect(parseOrigin("https://auth.example.")).toBeNull();
    expect(parseOrigin("https://auth.example.test:443")).toBeNull();
    expect(parseOrigin("https://Auth.example.test")).toBeNull();
    expect(parseOrigin("http://[::1]:23380")).toBe("http://[::1]:23380");
  });
});

describe("PKCE, state and the exact callback", () => {
  it("sends an S256 challenge to /authorize and the matching verifier to the exchange, with one exact redirect URI", async () => {
    const { auth } = await signIn();
    expect(auth.origin).toBe(ISSUER);
    expect(auth.pathname).toBe("/authorize");
    expect(auth.searchParams.get("client_id")).toBe("inferos");
    expect(auth.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("prompt")).toBe("select_account");
    const exchange = seen.find(s => s.path === "/auth/token")!.body;
    expect(exchange).toMatchObject({ clientId: "inferos", code: "the-code", redirectUri: REDIRECT_URI });
    expect(await sha256base64url(String(exchange.codeVerifier))).toBe(auth.searchParams.get("code_challenge"));
  });

  it("keeps the redirect URI it authorized under, even if BASE_URL changes mid-flow", async () => {
    const attempt = await started();
    const auth = await authorize(attempt.attemptId, attempt.nonce);
    const moved = "http://localhost:9999/gatekeeper/inferlab";
    await get(`${moved}/oauth?code=c&state=${auth.searchParams.get("state")}`, { BASE_URL: moved });
    expect(seen.find(s => s.path === "/auth/token")!.body.redirectUri).toBe(REDIRECT_URI);
  });

  it("refuses a callback whose state is wrong, and leaves the real attempt usable", async () => {
    const attempt = await started();
    const auth = await authorize(attempt.attemptId, attempt.nonce);
    const state = auth.searchParams.get("state")!;
    const [id] = state.split(".");
    for (const bad of [`${id}.${"0".repeat(64)}`, `${id}`, `${id}.x.y`, "nonsense", ""]) {
      const page = await get(`${REDIRECT_URI}?code=c&state=${bad}`);
      expect(page.status).toBe(400);
    }
    expect(seen).toEqual([]);
    expect((await get(`${REDIRECT_URI}?code=c&state=${state}`)).status).toBe(200);
  });

  it("refuses a replayed callback: the state is single use", async () => {
    const { state } = await signIn();
    const replay = await get(`${REDIRECT_URI}?code=the-code&state=${state}`);
    expect(replay.status).toBe(400);
    expect(seen.filter(s => s.path === "/auth/token")).toHaveLength(1);
  });

  it("refuses a replayed sign-in link: the initiation nonce is single use", async () => {
    const attempt = await started();
    await authorize(attempt.attemptId, attempt.nonce);
    expect((await get(`${BASE}/${attempt.attemptId}/${attempt.nonce}`)).status).toBe(400);
  });

  it("refuses a sign-in link with the wrong nonce", async () => {
    const attempt = await started();
    expect((await get(`${BASE}/${attempt.attemptId}/${"9".repeat(64)}`)).status).toBe(400);
    // ...and the right one still works.
    await authorize(attempt.attemptId, attempt.nonce);
  });

  it("ends the attempt when InferLab reports an error, so the state can't be used after", async () => {
    const attempt = await started();
    const state = (await authorize(attempt.attemptId, attempt.nonce)).searchParams.get("state")!;
    expect((await get(`${REDIRECT_URI}?error=access_denied&state=${state}`)).status).toBe(400);
    expect((await get(`${REDIRECT_URI}?code=c&state=${state}`)).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it.each([
    ["a duplicate state, the valid one first", (state: string) => `code=c&state=${state}&state=${state.split(".")[0]}.${"0".repeat(64)}`],
    ["a duplicate state, the valid one second", (state: string) => `code=c&state=${state.split(".")[0]}.${"0".repeat(64)}&state=${state}`],
    ["the same state twice", (state: string) => `code=c&state=${state}&state=${state}`],
    ["a duplicate code", (state: string) => `code=c&code=d&state=${state}`],
    ["both doubled", (state: string) => `code=c&code=d&state=${state}&state=${state}`],
    ["a duplicate error", (state: string) => `error=access_denied&error=x&state=${state}`],
  ])("refuses a callback with %s, exchanges nothing, and ends the attempt", async (_why, query) => {
    const attempt = await started();
    const state = (await authorize(attempt.attemptId, attempt.nonce)).searchParams.get("state")!;
    const page = await get(`${REDIRECT_URI}?${query(state)}`);
    expect(page.status).toBe(400);
    // The real state is spent: a clean callback with it afterwards is refused too.
    expect((await get(`${REDIRECT_URI}?code=c&state=${state}`)).status).toBe(400);
    expect(seen).toEqual([]);
    expect(await hooks().received(attempt.label)).toBeNull();
  });

  it("treats an error with a code as an error: the attempt ends and the code is never exchanged", async () => {
    const attempt = await started();
    const state = (await authorize(attempt.attemptId, attempt.nonce)).searchParams.get("state")!;
    expect((await get(`${REDIRECT_URI}?error=access_denied&code=c&state=${state}`)).status).toBe(400);
    expect((await get(`${REDIRECT_URI}?code=c&state=${state}`)).status).toBe(400);
    expect(seen).toEqual([]);
    expect(await hooks().received(attempt.label)).toBeNull();
  });

  it("answers only the two legs: any other path or method is not found", async () => {
    expect((await get(`${BASE}/oauth/extra`)).status).toBe(404);
    expect((await get(`${BASE}/elsewhere`)).status).toBe(404);
    const post = await worker.fetch(new Request(`${REDIRECT_URI}?code=c&state=x`, { method: "POST" }),
                                    env as Env, ctx);
    expect(post.status).toBe(404);
  });
});

describe("what InferLab answers is checked", () => {
  it.each([
    ["no subject", { id: undefined }],
    ["a subject with a space", { id: "a b" }],
    ["a non-ASCII subject", { id: "pé" }],
    ["no company", { tenantId: undefined }],
  ])("refuses a token response with %s", async (_why, user) => {
    tokenAnswer = tokenOk(user);
    const { label, text } = await signIn();
    expect(text).toContain("incomplete sign-in response");
    expect(await hooks().received(label)).toBeNull();
  });

  it("shows InferLab's refusal by status only, never its body", async () => {
    tokenAnswer = () => new Response("redirect_uri mismatch: secret detail", { status: 400 });
    const { text } = await signIn();
    expect(text).toContain("InferLab refused the sign-in (HTTP 400).");
    expect(text).not.toContain("secret detail");
  });
});

// FAC-296 part 2: reaching an InferLab edge that admits only known callers. The dev sign-in proxy
// sends the browser to INFERLAB_AUTHORIZE_ORIGIN, which this gatekeeper serves by forwarding to the
// issuer; the code exchange and the logout carry the edge secret. Same subject, same pipeline.
describe("the InferLab edge (FAC-296)", () => {
  const PROXY = "http://127.0.0.1:23381";
  const SECRET = "edge_secret-0123456789abcdefABCDEF0123";
  type Sent = { url: string; headers: Headers };
  let sent: Sent[] = [];

  beforeEach(() => {
    sent = [];
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      sent.push({ url, headers: new Headers(init?.headers) });
      if (new URL(url).pathname === "/authorize") return new Response("sign-in page", { status: 200 });
      return inner(input, init);
    });
  });

  it("sends the browser to the proxy when set, and exchanges the code at the issuer", async () => {
    const attempt = await started();
    const link = await get(`${BASE}/${attempt.attemptId}/${attempt.nonce}`, { INFERLAB_AUTHORIZE_ORIGIN: PROXY });
    expect(link.status).toBe(302);
    const auth = new URL(link.headers.get("location")!);
    expect(auth.origin).toBe(PROXY);
    expect(auth.pathname).toBe("/authorize");
    expect(auth.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    const callback = await get(`${REDIRECT_URI}?code=the-code&state=${auth.searchParams.get("state")}`,
      { INFERLAB_AUTHORIZE_ORIGIN: PROXY });
    expect(callback.status).toBe(200);
    expect(sent.map(s => new URL(s.url).origin)).toEqual([ISSUER, ISSUER]);
  });

  it("serves the proxy host by forwarding the sign-in page to the issuer, with the edge header", async () => {
    const page = await get(`${PROXY}/authorize?client_id=inferos&state=s`,
      { INFERLAB_AUTHORIZE_ORIGIN: PROXY, INFEROPS_EDGE_SECRET: SECRET });
    expect(await page.text()).toBe("sign-in page");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${ISSUER}/authorize?client_id=inferos&state=s`);
    expect(sent[0]!.headers.get("x-inferos-edge")).toBe(SECRET);
    expect(sent[0]!.headers.get("x-inferos-authorize-origin")).toBe(PROXY);
    // Anything but central-auth's browser legs is a 404, and InferLab isn't called.
    expect((await get(`${PROXY}/workspaces`, { INFERLAB_AUTHORIZE_ORIGIN: PROXY })).status).toBe(404);
    expect(sent).toHaveLength(1);
  });

  it("without a proxy origin, the proxy host is not served", async () => {
    const response = await get(`${PROXY}/authorize?client_id=inferos`);
    expect(response.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it("the code exchange and the logout carry the edge secret when set, and only then", async () => {
    // The Durable Object that completes a sign-in calls these with inferLabTarget(readConfig(env)).
    for (const edge of [SECRET, undefined]) {
      sent = [];
      const target = { origin: ISSUER, ...(edge ? { edge } : {}) };
      const signedIn = await exchangeCode(target, "the-code", "verifier", REDIRECT_URI);
      expect(signedIn.subject).toEqual({ issuer: ISSUER, subject: PRINCIPAL });
      await endSession(target, signedIn.refreshToken);
      expect(sent.map(s => new URL(s.url).pathname)).toEqual(["/auth/token", "/auth/logout"]);
      expect(sent.map(s => s.headers.get("x-inferos-edge"))).toEqual(edge ? [SECRET, SECRET] : [null, null]);
    }
    const config = readConfig({
      INFERLAB_AUTH_ORIGIN: ISSUER, INFEROPS_COMPANY: COMPANY, BASE_URL: BASE, INFEROPS_EDGE_SECRET: SECRET,
    });
    expect("off" in config ? null : inferLabTarget(config)).toEqual({ origin: ISSUER, edge: SECRET });
  });

  it("a set but malformed proxy origin, or the issuer itself, turns sign-in off", () => {
    const base = { INFERLAB_AUTH_ORIGIN: ISSUER, INFEROPS_COMPANY: COMPANY, BASE_URL: BASE };
    for (const bad of ["not a url", `${PROXY}/path`, ISSUER, "ftp://127.0.0.1"]) {
      expect(readConfig({ ...base, INFERLAB_AUTHORIZE_ORIGIN: bad }), bad).toEqual({ off: NOT_CONFIGURED.authorizeOrigin });
    }
    expect(readConfig({ ...base, INFERLAB_AUTHORIZE_ORIGIN: PROXY })).toMatchObject({ authorizeOrigin: PROXY });
    expect(readConfig(base)).toMatchObject({ authorizeOrigin: null });
    expect(readConfig({ ...base, INFEROPS_EDGE_SECRET: "too-short" })).not.toHaveProperty("edge");
  });

  // Every request to InferLab goes through the kit's inferLabFetch. A new `fetch(` call in this
  // package would reach InferLab without the edge header, so it fails here first.
  it("no source file calls the global fetch directly", () => {
    const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });
    expect(Object.keys(sources).length).toBeGreaterThan(2);
    const offenders = Object.entries(sources)
      .filter(([, text]) => /(?<![.\w]|async )fetch\s*\(|globalThis\.fetch|=\s*fetch\b/m.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

// FAC-300: one Google sign-in through InferLab central auth. A sign-in the Workshop asks to keep
// holds its InferLab session in its attempt object, backing the Workshop session: first it asks
// InferLab to reuse a live sign-in (`prompt=none`), going on to an interactive leg when there is
// none, and the account it hands over checks the session (a refresh) and ends the person's sign-in
// everywhere (`/auth/sign-out`).
const KEEP: SignInPurpose = { keep: true, silent: true };
const KEEP_CHOOSER: SignInPurpose = { keep: true, silent: false };

/** What an attempt object still holds of a kept sign-in, read inside it. */
const keptOf = (attemptId: string) => runInDurableObject(
  env.SIGN_IN_ATTEMPT.get(env.SIGN_IN_ATTEMPT.idFromString(attemptId)),
  async (_: SignInAttempt, state) => ({
    kept: state.storage.kv.get<{ refreshToken: string }>("kept") ?? null,
    alarm: await state.storage.getAlarm(),
  }));

/** A kept sign-in, through a silent leg InferLab answers with a code. */
async function keptSignIn(purpose: SignInPurpose = KEEP) {
  const attempt = await started(purpose);
  const auth = await authorize(attempt.attemptId, attempt.nonce);
  const callback = await get(`${REDIRECT_URI}?code=the-code&state=${auth.searchParams.get("state")}`);
  expect(callback.status).toBe(200);
  return { ...attempt, auth };
}

describe("a sign-in the Workshop asks to keep (FAC-300)", () => {
  it("asks InferLab to reuse a live sign-in first, and the chooser when the Workshop asks for it", async () => {
    const silent = await started(KEEP);
    expect((await authorize(silent.attemptId, silent.nonce)).searchParams.get("prompt")).toBe("none");
    const chooser = await started(KEEP_CHOOSER);
    expect((await authorize(chooser.attemptId, chooser.nonce)).searchParams.get("prompt")).toBe("select_account");
    // A sign-in that keeps nothing always shows the chooser, even if it asked to be silent.
    const transient = await started({ keep: false, silent: true });
    expect((await authorize(transient.attemptId, transient.nonce)).searchParams.get("prompt")).toBe("select_account");
  });

  it("starts as the Workshop asked through connectAccount", async () => {
    for (const [options, prompt] of [
      [{ keepSignIn: true, chooseAccount: false }, "none"],
      [{ keepSignIn: true, chooseAccount: true }, "select_account"],
      [{ keepSignIn: true }, "select_account"],
      [{ chooseAccount: false }, "select_account"],
      [{}, "select_account"],
    ] as const) {
      const url = await hooks().vendorConnect({ scopes: "auth", ...options });
      const response = await get(url);
      expect(new URL(response.headers.get("location")!).searchParams.get("prompt"), JSON.stringify(options))
        .toBe(prompt);
    }
  });

  it("goes on, once, to an interactive leg with no prompt for every answer that means InferLab needs a page", async () => {
    for (const error of ["login_required", "interaction_required", "consent_required", "account_selection_required"]) {
      const attempt = await started(KEEP);
      const silent = await authorize(attempt.attemptId, attempt.nonce);
      const resumed = await get(`${REDIRECT_URI}?error=${error}&state=${silent.searchParams.get("state")}`);
      expect(resumed.status, error).toBe(302);
      const leg = new URL(resumed.headers.get("location")!);
      expect(`${leg.origin}${leg.pathname}`).toBe(`${ISSUER}/authorize`);
      expect(leg.searchParams.has("prompt"), error).toBe(false);
      expect(leg.searchParams.get("state")).not.toBe(silent.searchParams.get("state"));
      expect(leg.searchParams.get("state")!.split(".")[0]).toBe(attempt.attemptId);
      expect(leg.searchParams.get("code_challenge")).not.toBe(silent.searchParams.get("code_challenge"));
      // The silent leg's state is spent: neither a replay of the error nor a code under it does anything.
      expect((await get(`${REDIRECT_URI}?error=${error}&state=${silent.searchParams.get("state")}`)).status).toBe(400);
      expect((await get(`${REDIRECT_URI}?code=c&state=${silent.searchParams.get("state")}`)).status).toBe(400);
      // There is no third leg: the interactive leg InferLab cannot complete ends the attempt.
      const ended = await get(`${REDIRECT_URI}?error=${error}&state=${leg.searchParams.get("state")}`);
      expect(ended.status).toBe(400);
      expect(await ended.text()).toContain("not completed");
    }
    expect(seen).toEqual([]);
  });

  it("completes on the interactive leg with that leg's own verifier", async () => {
    const attempt = await started(KEEP);
    const silent = await authorize(attempt.attemptId, attempt.nonce);
    const leg = new URL((await get(
      `${REDIRECT_URI}?error=login_required&state=${silent.searchParams.get("state")}`)).headers.get("location")!);
    const done = await get(`${REDIRECT_URI}?code=the-code&state=${leg.searchParams.get("state")}`);
    expect(done.status).toBe(200);
    const exchange = seen.find(s => s.path === "/auth/token")!.body;
    expect(await sha256base64url(String(exchange.codeVerifier))).toBe(leg.searchParams.get("code_challenge"));
    expect(await hooks().received(attempt.label)).toMatchObject({ subject: { issuer: ISSUER, subject: PRINCIPAL } });
  });

  it("ends the attempt on any other error, and on a needs-a-page error to a leg that asked for the chooser", async () => {
    const denied = await started(KEEP);
    const silent = await authorize(denied.attemptId, denied.nonce);
    expect((await get(`${REDIRECT_URI}?error=access_denied&state=${silent.searchParams.get("state")}`)).status).toBe(400);
    expect((await get(`${REDIRECT_URI}?code=c&state=${silent.searchParams.get("state")}`)).status).toBe(400);
    const chooser = await started(KEEP_CHOOSER);
    const shown = await authorize(chooser.attemptId, chooser.nonce);
    expect((await get(`${REDIRECT_URI}?error=login_required&state=${shown.searchParams.get("state")}`)).status).toBe(400);
    expect((await get(`${REDIRECT_URI}?code=c&state=${shown.searchParams.get("state")}`)).status).toBe(400);
  });

  it("keeps the session, only in its attempt object, held for thirty days", async () => {
    const before = Date.now();
    const { attemptId, label } = await keptSignIn();
    expect(seen.map(s => s.path)).toEqual(["/auth/token"]);
    const { kept, alarm } = await keptOf(attemptId);
    expect(kept).toEqual({ refreshToken: "refresh-token-ended-at-once" });
    expect(alarm).toBeGreaterThanOrEqual(before + KEPT_SIGN_IN_LIFETIME_MS);
    // The Workshop is handed the person, never a token.
    const got = JSON.stringify(await hooks().received(label));
    expect(got).not.toContain("refresh-token");
    expect(got).not.toContain("access-token");
  });

  it("is live while InferLab refreshes the session, which rotates it, and renews the hold", async () => {
    const { attemptId } = await keptSignIn();
    expect(await hooks().checkSignIn(attemptId)).toBe(true);
    expect(await hooks().checkSignIn(attemptId)).toBe(true);
    expect(seen.filter(s => s.path === "/auth/refresh").map(s => s.body.refreshToken))
      .toEqual(["refresh-token-ended-at-once", "rotated-1"]);
    expect((await keptOf(attemptId)).kept).toEqual({ refreshToken: "rotated-2" });
  });

  it("shares one refresh between concurrent checks, so no refresh token is presented twice", async () => {
    const { attemptId } = await keptSignIn();
    const answers = await Promise.all([hooks().checkSignIn(attemptId), hooks().checkSignIn(attemptId), hooks().checkSignIn(attemptId)]);
    expect(answers).toEqual([true, true, true]);
    const presented = seen.filter(s => s.path === "/auth/refresh").map(s => s.body.refreshToken);
    expect(new Set(presented).size).toBe(presented.length);
  });

  it("has ended once InferLab refuses the refresh, and then holds nothing and asks nothing", async () => {
    const { attemptId } = await keptSignIn();
    refreshAnswer = () => Response.json({ error: "unauthorized" }, { status: 401 });
    expect(await hooks().checkSignIn(attemptId)).toBe(false);
    expect(await keptOf(attemptId)).toEqual({ kept: null, alarm: null });
    expect(await hooks().checkSignIn(attemptId)).toBe(false);
    expect(seen.filter(s => s.path === "/auth/refresh")).toHaveLength(1);
  });

  it("says nothing either way when InferLab cannot answer", async () => {
    const { attemptId } = await keptSignIn();
    refreshAnswer = () => new Response("down", { status: 503 });
    expect(await hooks().checkSignIn(attemptId)).toMatch(/HTTP 503/);
    expect((await keptOf(attemptId)).kept).not.toBeNull();
  });

  it("is ended everywhere with /auth/sign-out, not only this session with /auth/logout, idempotently", async () => {
    const { attemptId } = await keptSignIn();
    expect(await hooks().endSignIn(attemptId)).toBeNull();
    expect(seen.map(s => s.path)).toEqual(["/auth/token", "/auth/sign-out"]);
    expect(seen[1]!.body).toEqual({ refreshToken: "refresh-token-ended-at-once" });
    expect(await keptOf(attemptId)).toEqual({ kept: null, alarm: null });
    expect(await hooks().checkSignIn(attemptId)).toBe(false);
    expect(await hooks().endSignIn(attemptId)).toBeNull();
    expect(seen.filter(s => s.path === "/auth/sign-out")).toHaveLength(1);
  });

  it("counts an already-ended session (401) as signed out", async () => {
    const { attemptId } = await keptSignIn();
    signOutAnswer = () => Response.json({ error: "unauthorized" }, { status: 401 });
    expect(await hooks().endSignIn(attemptId)).toBeNull();
  });

  it("reports a sign-out InferLab refused, so it never reads as done, and keeps the session for the alarm", async () => {
    const { attemptId } = await keptSignIn();
    signOutAnswer = () => new Response("down", { status: 503 });
    expect(await hooks().endSignIn(attemptId)).toContain("HTTP 503");
    expect((await keptOf(attemptId)).kept).not.toBeNull();
  });

  it("ends the kept session alone when the Workshop revokes a sign-in it did not use", async () => {
    const { attemptId } = await keptSignIn();
    await hooks().revoke(attemptId);
    expect(seen.map(s => s.path)).toEqual(["/auth/token", "/auth/logout"]);
    expect(await keptOf(attemptId)).toEqual({ kept: null, alarm: null });
  });

  it("ends the kept session when the Workshop refuses the sign-in inside complete()", async () => {
    const attempt = await started(KEEP, { revokeOnComplete: true });
    const auth = await authorize(attempt.attemptId, attempt.nonce);
    expect((await get(`${REDIRECT_URI}?code=c&state=${auth.searchParams.get("state")}`)).status).toBe(200);
    expect(seen.map(s => s.path)).toEqual(["/auth/token", "/auth/logout"]);
    expect(await keptOf(attempt.attemptId)).toEqual({ kept: null, alarm: null });
  });

  it("keeps no session from another company", async () => {
    tokenAnswer = tokenOk({ tenantId: OTHER });
    const attempt = await started(KEEP);
    const auth = await authorize(attempt.attemptId, attempt.nonce);
    expect((await get(`${REDIRECT_URI}?code=c&state=${auth.searchParams.get("state")}`)).status).toBe(502);
    expect(seen.map(s => s.path)).toEqual(["/auth/token", "/auth/logout"]);
    expect((await keptOf(attempt.attemptId)).kept).toBeNull();
  });

  it("ends the kept session once its hold runs out", async () => {
    const { attemptId } = await keptSignIn();
    await runInDurableObject(env.SIGN_IN_ATTEMPT.get(env.SIGN_IN_ATTEMPT.idFromString(attemptId)),
      (instance: SignInAttempt) => instance.alarm());
    expect(seen.map(s => s.path)).toEqual(["/auth/token", "/auth/logout"]);
    expect(await keptOf(attemptId)).toEqual({ kept: null, alarm: null });
  });

  it("a sign-in that keeps nothing hands over an account with no sign-in to check or end", async () => {
    await signIn();
    expect(await hooks().checkSignIn(null)).toBe(false);
    expect(await hooks().endSignIn(null)).toBeNull();
    expect(seen.map(s => s.path)).toEqual(["/auth/token", "/auth/logout"]);
  });
});
