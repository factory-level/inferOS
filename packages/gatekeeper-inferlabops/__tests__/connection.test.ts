// FAC-235's acceptance suite: the InferLab operations connection against a fake InferOps, faked at
// `fetch` (mock mode: no network, no real provider). Each person's token decides what the fake
// answers, live, as InferOps' own grants would.
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";
import {
  GATEKEEPER_PATH, ISSUER_PATTERN, NOT_CONFIGURED, OPERATIONS_CALLBACK_PATH, readConfig, readDestinations, receivesEventsFor,
} from "../src/config.js";
import { CONTRACT_PATTERNS, MAX_EVENT_BYTES, TOLERANCE_SECONDS, isCommittedEvent, parseEnvelope } from "../src/events.js";
import committedEventSchema from "../../../scripts/inferlab-contracts/schemas/inferlab.committed-event.v1.schema.json";
import committedEventFixtures from "../../../scripts/inferlab-contracts/fixtures/inferlab.committed-event.v1.json";
import { ISSUER_PATTERN as SIGN_IN_ISSUER_PATTERN } from "../../gatekeeper-inferlab/src/config.js";

const ORIGIN = "http://localhost:23380";
const BASE = `http://localhost:8787${GATEKEEPER_PATH}`;
const COMPANY = "00000000-0000-4000-8000-000000000001";
const OTHER_COMPANY = "00000000-0000-4000-8000-0000000000f2";
const WS = "00000000-0000-4000-8000-000000000011";
const PROJECT = "00000000-0000-4000-8000-00000000a201";
const OTHER_PROJECT = "00000000-0000-4000-8000-00000000a202";
const LOC = "00000000-0000-4000-8000-00000000a211";
const LOC_ELSEWHERE = "00000000-0000-4000-8000-00000000a212";
const ADDRESS = `inferops://acme.operations/project/project/${PROJECT}`;
const EVENT = "00000000-0000-4000-8000-0000000000e1";

type Who = "owner" | "observer" | "nomember" | "other";
const PRINCIPAL: Record<Who, string> = {
  owner: "00000000-0000-4000-8000-000000000103",
  observer: "00000000-0000-4000-8000-000000000104",
  nomember: "00000000-0000-4000-8000-00000000a221",
  other: "00000000-0000-4000-8000-00000000a233",
};

// ── The fake InferOps ──────────────────────────────────────────────────────────────────────────
type Seen = { method: string; path: string; headers: Record<string, string>; body: unknown };
let seen: Seen[] = [];
/** Access tokens alive now, by token. */
let tokens = new Map<string, Who>();
/** Refresh tokens alive now. */
let refreshes = new Map<string, Who>();
/** People whose InferOps grant was revoked since connecting. */
let grantRevoked = new Set<Who>();
let reviewStatus: "none" | "requested" = "none";
let revision = 3;
let minted = 0;
/** An answer the fake gives instead of a normal one, for outage tests. */
let outage = false;
/** Idempotency keys InferOps has committed, with the request each was for. */
let usedKeys = new Map<string, string>();
/** Fail the next review request with a 503, after nothing was committed. */
let failNextReview = false;
/** Make `/auth/logout` fail. */
let logoutFails = false;
/** A company id `/auth/company` answers instead of the person's own. */
let companyAnswer: string | null = null;
/** Changes to the committed event the fake answers, for mismatch tests (`null`: malformed). */
let eventEdit: Record<string, unknown> | null = {};

const jwt = (exp: number) => `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.s`;

function mint(who: Who): { token: string; refreshToken: string } {
  const n = ++minted;
  const token = `${jwt(Math.floor(Date.now() / 1000) + 900)}.${who}.${n}`;
  const refreshToken = `iexr_${who}_${n}`;
  tokens.set(token, who);
  refreshes.set(refreshToken, who);
  return { token, refreshToken };
}

const ref = (kind: string, id: string) => ({ v: 1, tenantId: COMPANY, kind, id });
const location = (id: string, project: string) => ({
  v: 1, ref: ref("project/location", id), project: ref("project/project", project),
  name: id === LOC ? "Main yard" : "Elsewhere", review: { status: reviewStatus }, revision: String(revision),
});
const reads = (who: Who) => who === "owner" || who === "observer";

function answer(method: string, path: string, query: URLSearchParams, who: Who | null,
                headers: Record<string, string>, body: unknown): Response {
  if (outage && path.startsWith("/project/")) return new Response("down", { status: 503 });
  if (path === "/auth/token") {
    const code = (body as { code?: string }).code ?? "";
    const person = code.replace(/^code-/, "") as Who;
    if (person === "other") return Response.json({ error: "company_not_this_deployment" }, { status: 403 });
    const t = mint(person);
    return Response.json({ ...t, user: { id: PRINCIPAL[person], tenantId: person === ("elsewhere" as Who) ? OTHER_COMPANY : COMPANY } });
  }
  if (path === "/auth/refresh") {
    const rt = (body as { refreshToken?: string }).refreshToken ?? "";
    const person = refreshes.get(rt);
    if (!person) return Response.json({ error: "invalid_grant" }, { status: 401 });
    refreshes.delete(rt);
    return Response.json(mint(person));
  }
  if (path === "/auth/logout" && logoutFails) return new Response("down", { status: 500 });
  if (path === "/auth/logout") {
    const rt = (body as { refreshToken?: string }).refreshToken ?? "";
    const person = refreshes.get(rt);
    refreshes.delete(rt);
    // The session's access tokens stay valid until they expire, as InferOps' do.
    void person;
    return new Response(null, { status: 204 });
  }
  if (!who) return Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const member = who !== "nomember";
  if (path === "/auth/company") {
    return Response.json({ tenantId: companyAnswer ?? COMPANY, slug: "acme", principalId: PRINCIPAL[who],
      workspaces: member ? [{ workspaceId: WS, workspaceName: "Operations", product: "inferops", role: who === "owner" ? "member" : "viewer" }] : [] });
  }
  if (path === "/workspaces") return Response.json([{ id: WS, tenant_id: COMPANY, product: "inferops", name: "Operations", slug: "operations" }]);
  const ws = headers["x-workspace-id"];
  const allowed = member && ws === WS && !grantRevoked.has(who) && reads(who);
  if (path === "/auth/permissions") {
    if (!member || ws !== WS || grantRevoked.has(who)) return Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
    const permission = query.get("permissions") ?? "";
    const has = permission === "location:read" || (permission === "location:write" && who === "owner");
    return Response.json({ workspaceId: WS, role: "x", assumed: false, primaryRole: null, roleAllows: [], roleDenies: [],
      deniedPermissions: [], decisions: [{ permission, allowed: has, reason: has ? "role-allow" : "no-allow" }] });
  }
  if (grantRevoked.has(who)) return Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
  if (path === `/project/projects/${PROJECT}` && method === "GET") {
    return allowed ? Response.json({ v: 1, ref: ref("project/project", PROJECT), key: "PROOF", name: "Proof", revision: "7" })
      : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  }
  if (path === "/project/locations" && method === "GET") {
    if (!allowed || query.get("project") !== PROJECT) return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    // The fake also slips in another Project's Location, which the gatekeeper must drop.
    return Response.json({ v: 1, items: [location(LOC, PROJECT), location(LOC_ELSEWHERE, OTHER_PROJECT)] });
  }
  if (path === `/project/locations/${LOC}` && method === "GET") {
    return allowed ? Response.json(location(LOC, PROJECT)) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  }
  if (path === `/project/locations/${LOC_ELSEWHERE}` && method === "GET") {
    return allowed ? Response.json(location(LOC_ELSEWHERE, OTHER_PROJECT)) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  }
  if (path === `/project/locations/${LOC}/events/${EVENT}` && method === "GET") {
    if (!allowed) return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    if (eventEdit === null) return Response.json({ v: 1, eventId: EVENT });
    return Response.json({
      v: 1, eventId: EVENT, type: "project.location.review_requested", occurredAt: "2026-11-14T20:00:00.000Z",
      tenantId: COMPANY, workspaceId: WS, resource: ref("project/location", LOC), resourceRevision: "4",
      actor: { type: "user", subject: { issuer: ORIGIN, subject: PRINCIPAL.owner } }, causationKey: "k_test0001",
      ...eventEdit,
    });
  }
  if (path === `/project/locations/${LOC}/review-request` && method === "POST") {
    if (!allowed) return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    if (who !== "owner") return Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
    if (failNextReview) {
      failNextReview = false;
      return new Response("down", { status: 503 });
    }
    // InferOps' idempotency: the same key for the same request replays; for another, it refuses.
    const key = headers["x-idempotency-key"] ?? "";
    const request = `${LOC}@${(body as { expectedRevision?: string }).expectedRevision}`;
    const prior = usedKeys.get(key);
    if (prior === request) return Response.json({ v: 1, revision: String(revision) });
    if (prior !== undefined) return Response.json({ error: { code: "IDEMPOTENCY_CONFLICT" } }, { status: 409 });
    if ((body as { expectedRevision?: string }).expectedRevision !== String(revision)) {
      return Response.json({ error: { code: "STALE_REVISION" } }, { status: 409 });
    }
    usedKeys.set(key, request);
    reviewStatus = "requested";
    revision += 1;
    return Response.json({ v: 1, revision: String(revision) });
  }
  return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
}

beforeEach(() => {
  seen = []; tokens = new Map(); refreshes = new Map(); grantRevoked = new Set();
  reviewStatus = "none"; revision = 3; outage = false; eventEdit = {};
  usedKeys = new Map(); failNextReview = false; logoutFails = false; companyAnswer = null;
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.origin !== ORIGIN) throw new Error(`unexpected fetch to ${url.origin}`);
    if (init?.redirect !== "manual") throw new Error("every call must refuse redirects");
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method: init?.method ?? "GET", path: url.pathname, headers, body });
    const bearer = headers.authorization?.replace(/^Bearer /, "") ?? "";
    return answer(init?.method ?? "GET", url.pathname, url.searchParams, tokens.get(bearer) ?? null, headers, body);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────
type Env = Parameters<typeof worker.fetch>[1];
const ctx = { exports: { ConnectAttempt: env.CONNECT_ATTEMPT } } as unknown as Parameters<typeof worker.fetch>[2];
const get = (url: string) => worker.fetch(new Request(url, { redirect: "manual" }), env as Env, ctx);
const hooks = () => env.TEST_HOOKS.getByName("hooks");
/** A session call's outcome; the stub's typing loses `unknown`, so it is restated here. */
type Outcome = { value?: any; error?: string };
const call = (key: string, method: string, ...args: unknown[]) =>
  hooks().call(key, method, ...args) as unknown as Promise<Outcome>;
const attention = (method: "approves" | "eligible" | "visible" | "verifyEvent", ...args: unknown[]) =>
  hooks().attention(method, ...args) as unknown as Promise<any>;

let counter = 0;
/** Connects `who` end to end through the browser legs; returns the attempt label. */
async function connect(who: Who): Promise<{ label: string; page: Response; authorize: URL }> {
  const attemptId = env.CONNECT_ATTEMPT.newUniqueId().toString();
  const nonce = (++counter).toString(16).padStart(64, "b");
  const label = `${who}-${counter}`;
  await hooks().startAttempt(attemptId, nonce, label);
  const first = await get(`${BASE}/${attemptId}/${nonce}`);
  expect(first.status).toBe(302);
  const authorize = new URL(first.headers.get("location")!);
  const state = authorize.searchParams.get("state")!;
  const page = await get(`${BASE}/oauth?code=code-${who}&state=${encodeURIComponent(state)}`);
  return { label, page, authorize };
}

const projectId = (id = PROJECT) => `tenant/${COMPANY}/workspace/${WS}/project/${id}`;
const locationId = (id = LOC) => `tenant/${COMPANY}/workspace/${WS}/location/${id}`;

// ── Configuration ──────────────────────────────────────────────────────────────────────────────
describe("configuration", () => {
  it("uses the InferLab contract's issuer rule, exactly as sign-in does", () => {
    expect(ISSUER_PATTERN.source).toBe(SIGN_IN_ISSUER_PATTERN.source);
  });

  it("fails closed on every missing or malformed setting", () => {
    const ok = { INFERLAB_AUTH_ORIGIN: ORIGIN, INFEROPS_COMPANY: COMPANY, BASE_URL: BASE };
    expect(readConfig(ok)).toEqual({ origin: ORIGIN, tenantId: COMPANY, baseUrl: BASE });
    expect(readConfig({ ...ok, INFERLAB_AUTH_ORIGIN: "http://evil.example" })).toEqual({ off: NOT_CONFIGURED.origin });
    expect(readConfig({ ...ok, INFEROPS_COMPANY: "acme" })).toEqual({ off: NOT_CONFIGURED.company });
    expect(readConfig({ ...ok, BASE_URL: "http://localhost:8787/gatekeeper/inferlab" })).toEqual({ off: NOT_CONFIGURED.baseUrl });
    expect(OPERATIONS_CALLBACK_PATH).toBe("/gatekeeper/inferlabops/oauth");
  });
});

// ── Connecting: explicit, separate from sign-in, company-bound ─────────────────────────────────
// ── Callback tampering (FAC-235 live QA): only the exact state of a live attempt completes ──────
describe("callback state tampering", () => {
  /** An attempt sent to InferLab but not yet returned: its genuine state, and the parts of it. */
  async function begun(who: Who) {
    const attemptId = env.CONNECT_ATTEMPT.newUniqueId().toString();
    const nonce = (++counter).toString(16).padStart(64, "c");
    const label = `${who}-${counter}`;
    await hooks().startAttempt(attemptId, nonce, label);
    const first = await get(`${BASE}/${attemptId}/${nonce}`);
    expect(first.status).toBe(302);
    const state = new URL(first.headers.get("location")!).searchParams.get("state")!;
    const [id, oauthNonce] = state.split(".") as [string, string];
    return { label, state, id, oauthNonce };
  }
  const callback = (state: string, who: Who = "owner") =>
    get(`${BASE}/oauth?code=code-${who}&state=${encodeURIComponent(state)}`);
  const flip = (hex: string, at: number) =>
    hex.slice(0, at) + (hex[at] === "0" ? "1" : "0") + hex.slice(at + 1);
  const exchanges = () => seen.filter(s => s.path === "/auth/token").length;

  it("refuses every altered state with the invalid-link page, exchanges no code and connects no one", async () => {
    const a = await begun("owner");
    const other = await begun("owner");
    const fresh = env.CONNECT_ATTEMPT.newUniqueId().toString();
    const tampered: [string, string][] = [
      ["one nonce digit changed", `${a.id}.${flip(a.oauthNonce, 10)}`],
      ["the nonce's case changed", `${a.id}.${a.oauthNonce.toUpperCase()}`],
      ["one attempt-id digit changed", `${flip(a.id, 5)}.${a.oauthNonce}`],
      ["another live attempt's id", `${other.id}.${a.oauthNonce}`],
      ["an unused but valid attempt id", `${fresh}.${a.oauthNonce}`],
      ["another live attempt's nonce", `${a.id}.${other.oauthNonce}`],
      ["the parts swapped", `${a.oauthNonce}.${a.id}`],
      ["an extra segment", `${a.state}.00`],
      ["no nonce", `${a.id}.`],
      ["no attempt id", `.${a.oauthNonce}`],
      ["empty", ""],
      ["the nonce truncated", `${a.id}.${a.oauthNonce.slice(0, 63)}`],
      ["the nonce padded", `${a.id}.${a.oauthNonce}0`],
    ];
    for (const [name, state] of tampered) {
      const res = await callback(state);
      expect(res.status, name).toBe(400);
      expect(await res.text(), name).toContain("link");
    }
    expect(exchanges()).toBe(0);
    expect(await hooks().received(a.label)).toBeNull();
    expect(await hooks().received(other.label)).toBeNull();

    // Nothing tampered burned the real attempts: each genuine state still completes, once.
    expect((await callback(a.state)).status).toBe(200);
    expect(await hooks().received(a.label)).not.toBeNull();
    expect((await callback(other.state)).status).toBe(200);
    expect(await hooks().received(other.label)).not.toBeNull();
    expect(exchanges()).toBe(2);
    // A replay of a spent state is refused like any other.
    expect((await callback(a.state)).status).toBe(400);
    expect(exchanges()).toBe(2);
  });
});

describe("connecting", () => {
  it("is never a sign-in: a connect asking for auth scopes is refused", async () => {
    expect(await hooks().vendorConnect("auth")).toMatch(/doesn't sign you in/);
    expect(await hooks().vendorConnect("full")).toBe("started");
  });

  it("authorizes the inferos client with PKCE at its own exact callback, account chooser kept", async () => {
    const { authorize, page, label } = await connect("owner");
    expect(authorize.origin + authorize.pathname).toBe(`${ORIGIN}/authorize`);
    expect(authorize.searchParams.get("client_id")).toBe("inferos");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("prompt")).toBe("select_account");
    expect(page.status).toBe(200);
    expect(JSON.parse((await hooks().received(label))!)).toEqual({ issuer: ORIGIN, subject: PRINCIPAL.owner });
    // The tokens are kept (no logout), and no token ever travels in a URL.
    expect(seen.filter(s => s.path === "/auth/logout")).toHaveLength(0);
    for (const s of seen) expect(s.path).not.toMatch(/iexr_|\.s\./);
  });

  it("refuses another company's session, in the person's words, and keeps nothing", async () => {
    const { page, label } = await connect("other");
    expect(page.status).toBe(502);
    expect(await page.text()).toMatch(/belongs to another company/);
    expect(await hooks().received(label)).toBeNull();
  });
});

// ── Binding one Project ────────────────────────────────────────────────────────────────────────
describe("binding a Project", () => {
  it("refuses when InferOps' live company isn't the one this connection was made in", async () => {
    const { label } = await connect("owner");
    companyAnswer = OTHER_COMPANY;
    expect((await hooks().bind(label, ADDRESS)).error).toMatch(/^Forbidden/);
  });

  it("binds the person's own Project, and refuses another company, an unheld workspace or an unreadable Project", async () => {
    const { label } = await connect("owner");
    expect((await hooks().bind(label, ADDRESS)).props?.url).toBe(ADDRESS);
    expect((await hooks().bind(label, `inferops://rival.operations/project/project/${PROJECT}`)).error).toMatch(/^NotFound/);
    expect((await hooks().bind(label, `inferops://acme.knowledge/project/project/${PROJECT}`)).error).toMatch(/^NotFound/);
    expect((await hooks().bind(label, `inferops://acme.operations/project/project/${OTHER_PROJECT}`)).error).toMatch(/^NotFound/);
    expect((await hooks().bind(label, "inferops://acme.operations/project/board/PROOF")).error).toMatch(/isn't an InferOps Project address/);
    const nomember = await connect("nomember");
    expect((await hooks().bind(nomember.label, ADDRESS)).error).toMatch(/^NotFound/);
  });
});

// ── Reads: live, as the person, every disclosure reported ──────────────────────────────────────
describe("reads", () => {
  it("reads the Project and its Locations, reporting every resource disclosed as restricted", async () => {
    const { label } = await connect("owner");
    await hooks().open(label, ADDRESS, "r1");
    expect((await call("r1", "getProject")).value).toMatchObject({ key: "PROOF" });
    const page = (await call("r1", "listLocations")).value as { items: { ref: { id: string } }[] };
    // Another Project's Location the API slipped in is dropped.
    expect(page.items.map(l => l.ref.id)).toEqual([LOC]);
    expect((await call("r1", "getLocation", LOC)).value).toMatchObject({ name: "Main yard" });
    expect((await call("r1", "getLocation", LOC_ELSEWHERE)).error).toMatch(/^NotFound/);
    const log = await hooks().log("r1");
    expect(log.observations.map(o => o.subresources)).toEqual([
      [projectId()],
      [projectId(), locationId()],
      [projectId(), locationId()],
    ]);
    expect(log.observations.every(o => o.containsRestrictedData === true)).toBe(true);
    // Every call carried the person's bearer and the bound workspace, and refused redirects.
    for (const s of seen.filter(s => s.path.startsWith("/project/"))) {
      expect(s.headers.authorization).toMatch(/^Bearer /);
      expect(s.headers["x-workspace-id"]).toBe(WS);
    }
  });

  it("follows the person's grants: an observer reads; a revoked grant stops the next read at once", async () => {
    const { label } = await connect("observer");
    await hooks().open(label, ADDRESS, "r2");
    expect((await call("r2", "getLocation", LOC)).value).toMatchObject({ name: "Main yard" });
    grantRevoked.add("observer");
    expect((await call("r2", "getLocation", LOC)).error).toMatch(/^Forbidden/);
    expect((await call("r2", "listLocations")).error).toMatch(/^Forbidden/);
  });

  it("an outage is an error, never an empty answer", async () => {
    const { label } = await connect("owner");
    await hooks().open(label, ADDRESS, "r3");
    outage = true;
    const listed = await call("r3", "listLocations");
    expect(listed.value).toBeUndefined();
    expect(listed.error).toMatch(/503/);
  });
});

// ── Requesting a review: an approved action ────────────────────────────────────────────────────
describe("requestReview", () => {
  it("is an action; reads show it pending; applying it sends the revision and an idempotency key", async () => {
    const { label } = await connect("owner");
    await hooks().open(label, ADDRESS, "a1");
    expect((await call("a1", "requestReview", LOC, "3")).error).toBeUndefined();
    const log = await hooks().log("a1");
    expect(log.actions).toHaveLength(1);
    expect(log.actions[0]!.description).toMatchObject({ actionKind: { tag: "request-review" }, autoApprovable: true });
    expect(seen.some(s => s.method === "POST" && s.path.startsWith("/project/"))).toBe(false);
    expect((await call("a1", "getLocation", LOC)).value).toMatchObject({ review: { status: "requested" } });
    expect(await hooks().apply("a1", log.actions[0]!.id)).toBeNull();
    const post = seen.find(s => s.method === "POST" && s.path.endsWith("/review-request"))!;
    expect(post.body).toEqual({ expectedRevision: "3" });
    expect(post.headers["x-idempotency-key"]).toMatch(/^inferos-[0-9a-f]{32}-1$/);
    expect(reviewStatus).toBe("requested");
  });

  it("an observer's request is Forbidden by InferOps when applied; a stale revision is StaleRevision", async () => {
    const observer = await connect("observer");
    await hooks().open(observer.label, ADDRESS, "a2");
    await call("a2", "requestReview", LOC, "3");
    const id = (await hooks().log("a2")).actions[0]!.id;
    expect(await hooks().apply("a2", id)).toMatch(/^Forbidden/);
    const owner = await connect("owner");
    await hooks().open(owner.label, ADDRESS, "a3");
    await call("a3", "requestReview", LOC, "2");
    expect(await hooks().apply("a3", (await hooks().log("a3")).actions[0]!.id)).toMatch(/^StaleRevision/);
  });

  it("two bindings in one workspace never send the same key; a retried action sends its own again", async () => {
    // Both facets live in one parent, as the overseer's do, so they share its id.
    const { label } = await connect("owner");
    await hooks().open(label, ADDRESS, "k1");
    await hooks().open(label, ADDRESS, "k2");
    await call("k1", "requestReview", LOC, "3");
    await call("k2", "requestReview", LOC, "3");
    const keys = () => seen.filter(s => s.method === "POST" && s.path.endsWith("/review-request"))
      .map(s => s.headers["x-idempotency-key"]!);

    // The first apply hits an outage after nothing committed; its retry sends the same key.
    failNextReview = true;
    const first = (await hooks().log("k1")).actions[0]!.id;
    expect(await hooks().apply("k1", first)).toMatch(/503/);
    expect(await hooks().apply("k1", first)).toBeNull();
    expect(keys()[0]).toBe(keys()[1]);

    // The other binding's request is its own, with its own key: InferOps sees no reuse.
    revision = 3; reviewStatus = "none";
    expect(await hooks().apply("k2", (await hooks().log("k2")).actions[0]!.id)).toBeNull();
    expect(new Set(keys()).size).toBe(2);
    expect(keys().every(k => /^inferos-[0-9a-f]{32}-1$/.test(k))).toBe(true);
  });

  it("a key InferOps already used for another request is IdempotencyConflict, in its own words", async () => {
    const { label } = await connect("owner");
    await hooks().open(label, ADDRESS, "k3");
    await call("k3", "requestReview", LOC, "3");
    const id = (await hooks().log("k3")).actions[0]!.id;
    // Make InferOps hold this binding's next key for a different request.
    failNextReview = true;
    expect(await hooks().apply("k3", id)).toMatch(/503/);
    const sent = seen.filter(s => s.path.endsWith("/review-request")).at(-1)!.headers["x-idempotency-key"]!;
    usedKeys.set(sent, `${LOC}@99`);
    expect(await hooks().apply("k3", id)).toBe(
      "IdempotencyConflict: InferOps already used this request's key for a different request, so it changed nothing.");
  });

  it("a rejected request leaves no simulated state behind", async () => {
    const { label } = await connect("owner");
    await hooks().open(label, ADDRESS, "a4");
    await call("a4", "requestReview", LOC, "3");
    await hooks().reject("a4", (await hooks().log("a4")).actions[0]!.id);
    expect((await call("a4", "getLocation", LOC)).value).toMatchObject({ review: { status: "none" } });
  });
});

// ── Observers: a collaborator inherits nothing ─────────────────────────────────────────────────
describe("observer access", () => {
  it("admits a collaborator only when their OWN connection can read every reported resource now", async () => {
    const owner = await connect("owner");
    const observer = await connect("observer");
    const nomember = await connect("nomember");
    await hooks().open(owner.label, ADDRESS, "o1");
    const all = [projectId(), locationId()];
    expect(await hooks().verify("o1", [observer.label, nomember.label], all)).toEqual([observer.label]);
    // The owner's Gadget read it earlier; that is no reason to admit anyone later.
    grantRevoked.add("observer");
    expect(await hooks().verify("o1", [observer.label], all)).toEqual([]);
  });

  it("admits through the verifier each person's own user entrypoint hands out, as the Workshop takes it", async () => {
    const owner = await connect("owner");
    const observer = await connect("observer");
    const nomember = await connect("nomember");
    await hooks().open(owner.label, ADDRESS, "o1");
    const all = [projectId(), locationId()];
    expect(await hooks().verifyThroughUsers("o1", [observer.label, nomember.label], all)).toEqual([observer.label]);
  });

  it("can't be told during an outage, so it throws rather than admit or deny", async () => {
    const owner = await connect("owner");
    const observer = await connect("observer");
    await hooks().open(owner.label, ADDRESS, "o2");
    outage = true;
    expect(await hooks().verify("o2", [observer.label], [projectId()])).toMatch(/503/);
  });

  it("refuses ids it never reports, or of another workspace or company", async () => {
    const owner = await connect("owner");
    await hooks().open(owner.label, ADDRESS, "o3");
    expect(await hooks().verify("o3", [owner.label], ["global"])).toMatch(/never reports/);
    expect(await hooks().verify("o3", [owner.label], [`tenant/${OTHER_COMPANY}/workspace/${WS}/project/${PROJECT}`]))
      .toMatch(/never reports/);
  });
});

// ── Revoking the connection ────────────────────────────────────────────────────────────────────
describe("revoking", () => {
  it("signs its own session out and deletes the tokens, so the very next read fails", async () => {
    const { label } = await connect("owner");
    await hooks().open(label, ADDRESS, "v1");
    expect((await call("v1", "getProject")).value).toBeDefined();
    await hooks().revoke(label);
    const logout = seen.find(s => s.path === "/auth/logout")!;
    expect((logout.body as { refreshToken: string }).refreshToken).toMatch(/^iexr_owner_/);
    const after = await call("v1", "getProject");
    expect(after.value).toBeUndefined();
    expect(after.error).toMatch(/^ConnectionExpired|not connected/);
  });

  it("still forgets the connection and deletes the tokens when the logout fails, and says so", async () => {
    const { label } = await connect("owner");
    const subject = (await hooks().subjectOf(label))!;
    await hooks().open(label, ADDRESS, "v3");
    logoutFails = true;
    await expect((async () => { await hooks().revoke(label); })()).rejects.toThrow(/didn't confirm signing this connection out/);
    // Forgotten: the attention authority no longer finds a connection for this person.
    expect(await attention("visible", subject, [{ v: 1, tenantId: COMPANY, kind: "project/location", id: LOC }]))
      .toEqual([false]);
    expect((await call("v3", "getProject")).error).toMatch(/^ConnectionExpired|not connected/);
  });

  it("a session InferLab ended (refresh refused) reads as ConnectionExpired and tells the Workshop once", async () => {
    const { label } = await connect("owner");
    await hooks().open(label, ADDRESS, "v2");
    // Signed out everywhere: every token of the session is gone.
    tokens.clear(); refreshes.clear();
    const after = await call("v2", "getProject");
    expect(after.error).toMatch(/^ConnectionExpired/);
    expect(await hooks().expiredLabels()).toContain(label);
  });
});

// ── The attention authority (FAC-237): each person's own connection, live ──────────────────────
describe("attention authority", () => {
  const target = { v: 1, tenantId: COMPANY, kind: "project/location", id: LOC };
  const intent = {
    v: 1, sourceEventId: EVENT, reason: "review_requested", target,
    audience: { kind: "permission-holders", workspaceId: WS, permission: "location:read" },
  };

  it("answers with each person's own access: no connection or no grant sees nothing", async () => {
    const owner = await connect("owner");
    const observer = await connect("observer");
    const nomember = await connect("nomember");
    const subj = async (l: string) => (await hooks().subjectOf(l))!;
    const stranger = { issuer: ORIGIN, subject: "00000000-0000-4000-8000-0000000000aa" };
    const ownerS = await subj(owner.label);
    expect(await attention("approves", { workspaceId: "w", owner: ownerS }, intent)).toBe(true);
    expect(await attention("eligible", intent, [ownerS, await subj(observer.label), await subj(nomember.label), stranger]))
      .toEqual([ownerS, await subj(observer.label)]);
    expect(await attention("visible", await subj(observer.label), [target, { ...target, tenantId: OTHER_COMPANY }]))
      .toEqual([true, false]);
    expect(await attention("visible", stranger, [target])).toEqual([false]);
  });

  it("a revoked recipient gets nothing at once: neither eligible nor visible", async () => {
    const owner = await connect("owner");
    const observer = await connect("observer");
    const observerS = (await hooks().subjectOf(observer.label))!;
    expect(await attention("visible", observerS, [target])).toEqual([true]);
    grantRevoked.add("observer");
    expect(await attention("visible", observerS, [target])).toEqual([false]);
    expect(await attention("eligible", intent, [observerS])).toEqual([]);
    grantRevoked.delete("observer");
    await hooks().revoke(observer.label);
    expect(await attention("visible", observerS, [target])).toEqual([false]);
    void owner;
  });

  it("verifyEvent: true only for a committed event the OWNER can read that matches the intent", async () => {
    const owner = await connect("owner");
    const ws = { workspaceId: "w", owner: (await hooks().subjectOf(owner.label))! };
    expect(await attention("verifyEvent", ws, intent)).toBe(true);
    // The request went to the event read, with the audience workspace, on the owner's own token.
    const read = seen.find(r => r.path === `/project/locations/${LOC}/events/${EVENT}`)!;
    expect(read.headers["x-workspace-id"]).toBe(WS);
    expect(read.headers.authorization).toMatch(/\.owner\./);

    // Not found, or another reason, kind, company or workspace: false.
    expect(await attention("verifyEvent", ws, { ...intent, sourceEventId: "00000000-0000-4000-8000-0000000000e2" })).toBe(false);
    expect(await attention("verifyEvent", ws, { ...intent, reason: "mentioned" })).toBe(false);
    expect(await attention("verifyEvent", ws, { ...intent, target: { ...target, kind: "project/project", id: PROJECT } })).toBe(false);
    expect(await attention("verifyEvent", ws, { ...intent, target: { ...target, tenantId: OTHER_COMPANY } })).toBe(false);
    expect(await attention("verifyEvent", ws, { ...intent, audience: { ...intent.audience, workspaceId: "00000000-0000-4000-8000-0000000000ff" } })).toBe(false);
    // InferOps' event disagreeing with the intent on any point: false.
    for (const edit of [
      { type: "project.location.renamed" },
      { workspaceId: "00000000-0000-4000-8000-0000000000ff" },
      { tenantId: OTHER_COMPANY },
      { resource: ref("project/location", LOC_ELSEWHERE) },
      { resource: { ...ref("project/location", LOC), tenantId: OTHER_COMPANY } },
      { resource: ref("project/project", LOC) },
      { eventId: "00000000-0000-4000-8000-0000000000e2" },
    ]) {
      eventEdit = edit;
      expect(await attention("verifyEvent", ws, intent), JSON.stringify(edit)).toBe(false);
    }
    eventEdit = {};
    // An owner with no connection, or whose grant is gone, can cite nothing.
    const stranger = { issuer: ORIGIN, subject: "00000000-0000-4000-8000-0000000000aa" };
    expect(await attention("verifyEvent", { workspaceId: "w", owner: stranger }, intent)).toBe(false);
    grantRevoked.add("owner");
    expect(await attention("verifyEvent", ws, intent)).toBe(false);
  });

  it("verifyEvent: an outage or an unreadable answer throws", async () => {
    const owner = await connect("owner");
    const ws = { workspaceId: "w", owner: (await hooks().subjectOf(owner.label))! };
    eventEdit = null;
    expect(await attention("verifyEvent", ws, intent)).toEqual({ thrown: expect.stringMatching(/unreadable/) });
    eventEdit = {};
    outage = true;
    expect(await attention("verifyEvent", ws, intent)).toEqual({ thrown: expect.stringMatching(/503/) });
  });

  it("an answer InferOps can't give throws, so nothing is delivered on a guess", async () => {
    const observer = await connect("observer");
    const observerS = (await hooks().subjectOf(observer.label))!;
    outage = true;
    expect(await attention("visible", observerS, [target])).toEqual({ thrown: expect.stringMatching(/503/) });
  });
});

// ── The configurator's copy of the address grammar matches the server's ─────────────────────────
describe("Project picker", () => {
  it("accepts exactly the addresses the server binds", async () => {
    const { parseProjectAddress } = await import("../src/worker.js");
    const source = await import("../src/configurator/project-configurator-ui.js");
    const spec = source.default as unknown as { isReady(c: { values: { address: string } }): boolean };
    for (const address of [
      ADDRESS, `inferops://acme.knowledge/project/project/${PROJECT}`, "inferops://acme.operations/project/board/PROOF",
      `inferops://ACME.operations/project/project/${PROJECT}`, `inferops://acme.operations/project/project/${PROJECT}/x`,
      `https://acme.operations/project/project/${PROJECT}`, "",
    ]) {
      expect(spec.isReady({ values: { address } }), address).toBe(parseProjectAddress(address) !== null);
    }
  });
});

// ── Events and hooks (FAC-236) ─────────────────────────────────────────────────────────────────

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const DESTINATION = "inferos-field-ops";
const OTHER_WS = "00000000-0000-4000-8000-0000000000aa";
let eventCounter = 0;
const nextEventId = () => `6f1c2a8e-4b1d-4c55-9a3e-${(++eventCounter).toString(16).padStart(12, "0")}`;
const eventsCtx = { exports: { ConnectAttempt: env.CONNECT_ATTEMPT, ProjectEventDriver: env.PROJECT_EVENT_DRIVER } } as unknown as Parameters<typeof worker.fetch>[2];
const driver = () => env.PROJECT_EVENT_DRIVER.getByName("events");

/** A committed event on `locationId`, and FAC-234's envelope around it. */
function envelope(eventId: string, over: Record<string, unknown> = {}, eventOver: Record<string, unknown> = {},
                  locationId = LOC): Record<string, unknown> {
  const event = {
    v: 1, eventId, type: "project.location.review_requested", occurredAt: "2026-11-15T04:00:00Z",
    tenantId: COMPANY, workspaceId: WS, resource: ref("project/location", locationId), resourceRevision: "4",
    actor: { type: "user", subject: { issuer: ORIGIN, subject: PRINCIPAL.owner } }, causationKey: "review-LOC-0001",
    ...eventOver,
  };
  return { v: 1, issuer: ORIGIN, destination: DESTINATION, tenantId: COMPANY, workspaceId: WS, event, ...over };
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
/** dispatch's `signInferlabPayload`, restated: `t=<s>,v1=<hex hmac_sha256(secret, "<t>.<body>")>`. */
async function sign(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `t=${at},v1=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${at}.${body}`)))}`;
}

/** The same signature over raw bytes, for a body that isn't text. */
async function signBytes(body: Uint8Array, at = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = new TextEncoder().encode(`${at}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  return `t=${at},v1=${hex(await crypto.subtle.sign("HMAC", key, message))}`;
}

/** One delivery to the ingress; `signature: null` sends none. */
async function deliver(body: string | Uint8Array, options: { signature?: string | null; deliveryId?: string | null;
  key?: string; method?: string } = {}): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const text = typeof body === "string" ? body : null;
  const signature = options.signature === undefined ? await sign(text ?? "") : options.signature;
  if (signature !== null) headers["x-inferlab-signature"] = signature;
  if (options.deliveryId !== null) {
    headers["x-inferlab-delivery"] = options.deliveryId ?? (text ? (JSON.parse(text) as { event?: { eventId?: string } }).event?.eventId ?? "" : "");
  }
  const response = await worker.fetch(new Request(`${BASE}/events/${options.key ?? DESTINATION}`, {
    method: options.method ?? "POST", headers, ...(options.method === "GET" ? {} : { body }),
  }), env as Env, eventsCtx);
  return { status: response.status, json: response.status === 202 ? await response.json() : null };
}

/** Deliver a signed, valid event for `locationId` with a fresh id; returns the id. */
async function deliverEvent(eventId = nextEventId(), locationId = LOC): Promise<string> {
  const body = JSON.stringify(envelope(eventId, {}, {}, locationId));
  const { status } = await deliver(body);
  expect(status).toBe(202);
  return eventId;
}

/** Whether the driver holds a checkpoint for `eventId`. */
const checkpointed = (eventId: string) => runInDurableObject(driver(), (_i, state) =>
  state.storage.kv.get(`seen:${eventId}`) !== undefined);

/**
 * Wait until what is due has been delivered. The runtime fires the driver's alarm by itself, so a
 * delivery may already be in flight; calling `alarm()` joins it (`HookRegistry.run`), then runs
 * anything still due.
 */
const drain = async () => {
  await runDurableObjectAlarm(driver());
  await runInDurableObject(driver(), (instance: { alarm(): Promise<void> }) => instance.alarm());
};

describe("the committed-event contract", () => {
  it("checks every field with the pinned schema's own patterns", () => {
    const props = (committedEventSchema as { properties: Record<string, any> }).properties;
    expect(CONTRACT_PATTERNS.uuid).toBe(props.eventId.pattern);
    expect(CONTRACT_PATTERNS.uuid).toBe(props.tenantId.pattern);
    expect(CONTRACT_PATTERNS.occurredAt).toBe(props.occurredAt.pattern);
    expect(CONTRACT_PATTERNS.resourceId).toBe(props.resource.properties.id.pattern);
    expect(CONTRACT_PATTERNS.revision).toBe(props.resourceRevision.pattern);
    expect(CONTRACT_PATTERNS.subject).toBe(props.actor.oneOf[0].properties.subject.properties.subject.pattern);
    expect(CONTRACT_PATTERNS.causationKey).toBe(props.causationKey.pattern);
  });

  it("accepts the contract's valid events and refuses its invalid ones", () => {
    for (const { name, value } of committedEventFixtures.valid) expect(isCommittedEvent(value), name).toBe(true);
    for (const { name, value } of committedEventFixtures.invalid) expect(isCommittedEvent(value), name).toBe(false);
  });

  it("reads destinations whole: anything malformed turns every one off", () => {
    const one = { key: DESTINATION, workspaceId: WS, secret: SECRET };
    expect([...readDestinations({ INFERLAB_EVENT_DESTINATIONS: JSON.stringify([one]) }).keys()]).toEqual([DESTINATION]);
    for (const bad of ["not json", "{}", JSON.stringify([{ ...one, secret: "short" }]), JSON.stringify([one, one]),
        JSON.stringify([{ ...one, key: "Bad_Key" }]), JSON.stringify([{ ...one, workspaceId: "ws" }]),
        JSON.stringify([one, { key: "x" }])]) {
      expect(readDestinations({ INFERLAB_EVENT_DESTINATIONS: bad }).size, bad).toBe(0);
    }
    expect(readDestinations({}).size).toBe(0);
    expect(receivesEventsFor({ INFERLAB_EVENT_DESTINATIONS: JSON.stringify([one]) }, WS)).toBe(true);
    expect(receivesEventsFor({ INFERLAB_EVENT_DESTINATIONS: JSON.stringify([one]) }, OTHER_WS)).toBe(false);
  });

  it("takes the scope from the destination, never from the payload", () => {
    const expected = { key: DESTINATION, issuer: ORIGIN, tenantId: COMPANY, workspaceId: WS, deliveryId: "" };
    const id = nextEventId();
    expect(parseEnvelope(envelope(id), { ...expected, deliveryId: id })).toMatchObject({ eventId: id, workspaceId: WS, locationId: LOC });
    expect(parseEnvelope(envelope(id, { workspaceId: OTHER_WS }, { workspaceId: OTHER_WS }), { ...expected, deliveryId: id }))
      .toEqual({ refused: "scope" });
  });
});

describe("event ingress", () => {
  it("refuses a forged, altered, stale, unknown, oversized, malformed or out-of-scope delivery, and records none", async () => {
    await hooks().resetHook();
    const id = nextEventId();
    const body = JSON.stringify(envelope(id));
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, Promise<{ status: number }>, number][] = [
      ["forged signature", deliver(body, { signature: await sign(body, "another-secret-0123456789abcdef0123") }), 401],
      ["body altered after signing", deliver(body.replace("\"43\"", "\"44\"").replace("review-LOC-0001", "review-LOC-0002"),
        { signature: await sign(body), deliveryId: id }), 401],
      ["stale timestamp", deliver(body, { signature: await sign(body, SECRET, now - TOLERANCE_SECONDS - 1) }), 401],
      ["future timestamp", deliver(body, { signature: await sign(body, SECRET, now + TOLERANCE_SECONDS + 1) }), 401],
      ["no signature", deliver(body, { signature: null }), 401],
      // Nothing is read before the signature: an unsigned or forged body is 401 however malformed.
      ["no signature, not JSON", deliver("not json", { signature: null, deliveryId: id }), 401],
      ["forged, schema-invalid", deliver(JSON.stringify({ v: 9 }), { signature: await sign("{}"), deliveryId: id }), 401],
      ["forged, another workspace", deliver(JSON.stringify(envelope(id, { workspaceId: OTHER_WS }, { workspaceId: OTHER_WS })),
        { signature: await sign(body) }), 401],
      ["malformed signature", deliver(body, { signature: `t=${now},v2=abc` }), 401],
      ["one hex digit of the signature changed", deliver(body, { signature: (await sign(body)).replace(/v1=(.)/, (_m, c: string) => `v1=${c === "0" ? "1" : "0"}`) }), 401],
      ["unknown destination key", deliver(body, { key: "inferos-elsewhere" }), 404],
      ["oversized body", deliver(JSON.stringify({ ...envelope(id), pad: "x".repeat(MAX_EVENT_BYTES) })), 413],
      ["signed, not JSON", deliver("not json", { deliveryId: id }), 400],
      ["signed, not UTF-8", deliver(new Uint8Array([0xff, 0xfe, 0x7b]), { signature: await signBytes(new Uint8Array([0xff, 0xfe, 0x7b])), deliveryId: id }), 400],
      ["envelope v2", deliver(JSON.stringify(envelope(id, { v: 2 }))), 400],
      ["delivery header names another event", deliver(body, { deliveryId: nextEventId() }), 400],
      ["a Project, not a Location", deliver(JSON.stringify(envelope(id, {}, { resource: ref("project/project", PROJECT) }))), 400],
      ["another company", deliver(JSON.stringify(envelope(id, { tenantId: OTHER_COMPANY },
        { tenantId: OTHER_COMPANY, resource: { ...ref("project/location", LOC), tenantId: OTHER_COMPANY } }))), 403],
      ["another workspace", deliver(JSON.stringify(envelope(id, { workspaceId: OTHER_WS }, { workspaceId: OTHER_WS }))), 403],
      ["envelope and event disagree", deliver(JSON.stringify(envelope(id, {}, { workspaceId: OTHER_WS }))), 403],
      ["another destination named inside", deliver(JSON.stringify(envelope(id, { destination: "inferos-other" }))), 403],
      ["another issuer", deliver(JSON.stringify(envelope(id, { issuer: "https://auth.elsewhere.example" }))), 403],
    ];
    for (const fixture of committedEventFixtures.invalid) {
      cases.push([`invalid event: ${fixture.name}`, deliver(JSON.stringify({ ...envelope(id), event: fixture.value }),
        { deliveryId: (fixture.value as { eventId?: string }).eventId ?? id }), 400]);
    }
    for (const [name, outcome, status] of cases) expect((await outcome).status, name).toBe(status);
    expect((await deliver(body, { method: "GET" })).status).toBe(405);
    expect(await checkpointed(id)).toBe(false);
  });

  it("is a retryable 503 while the receiver is off, never a terminal 404; 404 only for an unknown key", async () => {
    const body = JSON.stringify(envelope(nextEventId()));
    const signature = await sign(body);
    const headers = { "content-type": "application/json", "x-inferlab-signature": signature,
      "x-inferlab-delivery": (JSON.parse(body) as { event: { eventId: string } }).event.eventId };
    const post = (overrides: Record<string, string | undefined>, key = DESTINATION) =>
      worker.fetch(new Request(`${BASE}/events/${key}`, { method: "POST", headers, body }),
        { ...env, ...overrides } as Env, eventsCtx).then(r => r.status);
    expect(await post({ INFEROPS_COMPANY: "" }), "connection settings off").toBe(503);
    expect(await post({ INFERLAB_AUTH_ORIGIN: "http://evil.example" }), "bad origin").toBe(503);
    for (const bad of ["not json", "[]", JSON.stringify([{ key: DESTINATION, workspaceId: WS, secret: "short" }]),
        JSON.stringify([{ key: DESTINATION, workspaceId: WS, secret: SECRET }, { key: DESTINATION, workspaceId: WS, secret: SECRET }])]) {
      expect(await post({ INFERLAB_EVENT_DESTINATIONS: bad }), bad).toBe(503);
    }
    expect(await post({ INFERLAB_EVENT_DESTINATIONS: undefined }), "no destinations configured").toBe(404);
    expect(await post({}, "inferos-elsewhere"), "unknown key, valid configuration").toBe(404);
  });

  it("acknowledges a signed delivery once it is recorded; the same event again changes nothing", async () => {
    const id = nextEventId();
    const body = JSON.stringify(envelope(id));
    expect(await deliver(body)).toEqual({ status: 202, json: { accepted: true, duplicate: false } });
    expect(await deliver(body)).toEqual({ status: 202, json: { accepted: true, duplicate: true } });
    // Re-signed later, as a retry would be: still the same event.
    expect(await deliver(body, { signature: await sign(body, SECRET, Math.floor(Date.now() / 1000) + 5) }))
      .toEqual({ status: 202, json: { accepted: true, duplicate: true } });
    expect(await checkpointed(id)).toBe(true);
  });
});

describe("hooks on a Project's events", () => {
  /** The owner connects and binds the Project; their session subscribes a hook (still disabled). */
  async function subscribed(): Promise<{ label: string; key: string }> {
    await hooks().resetHook();
    const owner = await connect("owner");
    const key = `ev-${++eventCounter}`;
    await hooks().open(owner.label, ADDRESS, key);
    const bound = await hooks().subscribe(key);
    expect(bound.description?.title).toBe(`Watch InferOps Project ${PROJECT}`);
    return { label: owner.label, key };
  }
  const received = async () => (await hooks().readHook()).received;
  /** Wait for the automatically fired alarm's delivery, without calling `alarm()` ourselves. */
  const waitForReceived = async (count: number) => {
    for (let i = 0; i < 100 && (await received()).length < count; i++) await new Promise(r => setTimeout(r, 50));
  };

  it("starts disabled: an event before it is enabled reaches nobody, one after reaches it once", async () => {
    await subscribed();
    await deliverEvent();
    await drain();
    expect(await received()).toEqual([]);
    expect(await hooks().enableHook()).toBeNull();
    const id = await deliverEvent();
    const body = JSON.stringify(envelope(id));
    expect((await deliver(body)).json).toEqual({ accepted: true, duplicate: true });
    await drain();
    await deliver(body);
    await drain();
    expect(await received()).toEqual([{
      eventId: id, type: "project.location.review_requested", location: "Main yard", locationProject: PROJECT,
      revision: "4", projectRead: "PROOF",
    }]);
    // The firing observed the Project and the Location, as a read does.
    expect((await hooks().readHook()).observations[0]).toEqual({
      title: "Received an InferOps event", subresources: [projectId(), locationId()],
    });
    // The Location was re-read with the owner's own token when the event arrived.
    expect(seen.filter(r => r.path === `/project/locations/${LOC}`).every(r => /\.owner\./.test(r.headers.authorization!)))
      .toBe(true);
  });

  it("re-checks admission at delivery: a revoked grant receives nothing", async () => {
    await subscribed();
    expect(await hooks().enableHook()).toBeNull();
    grantRevoked.add("owner");
    await deliverEvent();
    await drain();
    expect(await received()).toEqual([]);
    expect((await hooks().readHook()).observations).toEqual([]);
  });

  it("never delivers another Project's Location", async () => {
    await subscribed();
    expect(await hooks().enableHook()).toBeNull();
    await deliverEvent(nextEventId(), LOC_ELSEWHERE);
    await drain();
    expect(await received()).toEqual([]);
  });

  it("a disabled hook receives nothing, and a deleted hook's firing discloses nothing", async () => {
    await subscribed();
    expect(await hooks().enableHook()).toBeNull();
    await hooks().disableHook();
    await deliverEvent();
    await drain();
    expect(await received()).toEqual([]);
    // Enabled again, then deleted in the Workshop: its firings are refused.
    expect(await hooks().enableHook()).toBeNull();
    await hooks().setHook({ refuse: true });
    await deliverEvent();
    await drain();
    expect(await received()).toEqual([]);
    expect((await hooks().readHook()).observations).toEqual([]);
  });

  it("a restart before delivery still delivers exactly once", async () => {
    await subscribed();
    expect(await hooks().enableHook()).toBeNull();
    const id = await deliverEvent();
    await evictDurableObject(driver());
    await drain();
    await deliver(JSON.stringify(envelope(id)));
    await evictDurableObject(driver());
    await drain();
    expect((await received()).map(r => r.eventId)).toEqual([id]);
  });

  it("acknowledges once recorded, not when the hook has run: a slow hook doesn't delay the 202", async () => {
    await subscribed();
    expect(await hooks().enableHook()).toBeNull();
    await hooks().setHook({ slowMs: 4000 });
    const started = Date.now();
    const id = nextEventId();
    expect((await deliver(JSON.stringify(envelope(id)))).status).toBe(202);
    expect(Date.now() - started).toBeLessThan(2000);
    await drain();
    expect((await received()).map(r => r.eventId)).toEqual([id]);
  }, 20_000);

  it("an alarm lost after the commit is restored by the sender's retry: the hook fires once", async () => {
    // A driver of its own: earlier tests' hooks, checkpoints and retry alarms would schedule it anyway.
    await runInDurableObject(driver(), async (_i, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
    await subscribed();
    expect(await hooks().enableHook()).toBeNull();
    await drain();
    // The next setAlarm fails, as an interrupted object or a failed write would leave it: the event
    // and its queued delivery are committed, but nothing is scheduled to deliver them.
    await runInDurableObject(driver(), (_i, state) => {
      const storage = state.storage as unknown as { setAlarm(at: number): Promise<void> };
      const real = storage.setAlarm.bind(storage);
      let failNext = true;
      storage.setAlarm = async (at: number) => {
        if (failNext) {
          failNext = false;
          throw new Error("injected: setAlarm failed after the commit");
        }
        return real(at);
      };
    });
    const id = nextEventId();
    const body = JSON.stringify(envelope(id));
    expect((await deliver(body)).status).toBe(503);
    expect(await checkpointed(id)).toBe(true);
    const alarmAt = () => runInDurableObject(driver(), (_i, state) => state.storage.getAlarm());
    // Nothing is scheduled: the delivery would wait forever.
    expect(await alarmAt()).toBeNull();
    expect(await received()).toEqual([]);
    // The sender retries the same event: a duplicate, which reconciles the alarm before it is acked.
    expect(await deliver(body)).toEqual({ status: 202, json: { accepted: true, duplicate: true } });
    // Reconciled: due now, so the runtime fires it by itself; nothing here calls alarm().
    await waitForReceived(1);
    expect((await received()).map(r => r.eventId)).toEqual([id]);
  });

  it("disconnecting drops the connection's hooks, and refuses enabling them again", async () => {
    const { label } = await subscribed();
    expect(await hooks().enableHook()).toBeNull();
    await hooks().revoke(label);
    await deliverEvent();
    await drain();
    expect(await received()).toEqual([]);
    expect(await hooks().enableHook()).toBe("This InferLab operations connection has been disconnected.");
  });
});
