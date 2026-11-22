// The InferLab edge (FAC-296 part 2), ported from the archived gatekeeper-inferops tests
// (origin/main 2ffa24dc5, auth-proxy.test.ts and edge-header.test.ts): the edge header goes to the
// one configured InferLab origin and nowhere else, and the dev sign-in proxy forwards only
// central-auth's browser legs, keeping redirects and cookies on the authorize host.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORIZE_ORIGIN_HEADER, INFERLAB_EDGE_HEADER, edgeSecretOf, handleInferLabAuthProxy, inferLabFetch, originOf,
} from "../src/inferlab-edge";

const SECRET = "edge_secret-0123456789abcdefABCDEF0123";
const AUTH = "https://auth.dev.inferlab.example";
const PROXY = "https://auth.dev-os.example";
const CALLBACK = "https://dev-os.example/gatekeeper/inferlab/oauth?code=c&state=s";
const TARGET = { origin: AUTH, edge: SECRET };

type Seen = { url: string; method?: string; headers: Headers; redirect: RequestInit["redirect"]; body?: string };

/** Stubs the global `fetch` (which `inferLabFetch` reads per call), recording each request. */
function upstream(reply: () => Response = () => new Response("page")) {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: input instanceof Request ? input.url : String(input), method: init?.method,
      headers: new Headers(init?.headers), redirect: init?.redirect,
      body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : undefined,
    });
    return reply();
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("edgeSecretOf", () => {
  it("takes only a value InferLab's edge rule accepts", () => {
    expect(edgeSecretOf({ INFEROPS_EDGE_SECRET: SECRET })).toBe(SECRET);
    expect(edgeSecretOf({ INFEROPS_EDGE_SECRET: ` ${SECRET} ` })).toBe(SECRET);
    for (const bad of [undefined, "", "   ", "short", `${SECRET}!`, `${SECRET} x`]) {
      expect(edgeSecretOf({ INFEROPS_EDGE_SECRET: bad }), String(bad)).toBeUndefined();
    }
  });
});

describe("inferLabFetch", () => {
  it("adds the header for the target's origin, keeps the caller's headers, and never follows a redirect", async () => {
    const seen = upstream();
    const send = inferLabFetch(TARGET);
    await send(`${AUTH}/auth/token`, { method: "POST", headers: { accept: "application/json" } });
    await send(`${AUTH}/project/projects`, { headers: new Headers({ authorization: "Bearer t" }), redirect: "follow" });
    expect(seen.map(s => s.headers.get(INFERLAB_EDGE_HEADER))).toEqual([SECRET, SECRET]);
    expect(seen.map(s => s.redirect)).toEqual(["manual", "manual"]);
    expect(seen[0]!.headers.get("accept")).toBe("application/json");
    expect(seen[1]!.headers.get("authorization")).toBe("Bearer t");
  });

  it("is plain fetch with no secret, or for a bare origin", async () => {
    const seen = upstream();
    await inferLabFetch({ origin: AUTH })(`${AUTH}/auth/token`, { method: "POST" });
    await inferLabFetch(AUTH)(`${AUTH}/auth/token`, { method: "POST" });
    expect(seen.every(s => !s.headers.has(INFERLAB_EDGE_HEADER))).toBe(true);
    expect(seen.every(s => s.redirect === undefined)).toBe(true);
    expect(originOf(AUTH)).toBe(AUTH);
    expect(originOf(TARGET)).toBe(AUTH);
  });

  it("never sends it to another origin, however close it looks", async () => {
    const seen = upstream();
    const send = inferLabFetch(TARGET);
    for (const url of [
      "https://evil.example/auth/token",
      "https://auth.dev.inferlab.example.evil.example/auth/token",
      "http://auth.dev.inferlab.example/auth/token",
      "https://auth.dev.inferlab.example:8443/auth/token",
      "https://dev.inferlab.example/",
      PROXY + "/authorize",
    ]) {
      await send(url, { redirect: "follow" });
    }
    expect(seen).toHaveLength(6);
    expect(seen.every(s => !s.headers.has(INFERLAB_EDGE_HEADER))).toBe(true);
    // A foreign request is passed through untouched.
    expect(seen.every(s => s.redirect === "follow")).toBe(true);
  });
});

describe("handleInferLabAuthProxy", () => {
  it("leaves other origins, and deployments without a distinct authorize origin, alone", async () => {
    const seen = upstream();
    expect(await handleInferLabAuthProxy(new Request("https://dev-os.example/authorize"), PROXY, TARGET)).toBeNull();
    expect(await handleInferLabAuthProxy(new Request(`${AUTH}/authorize`), AUTH, TARGET))
      .toBeNull();
    expect(await handleInferLabAuthProxy(new Request(`${PROXY}/authorize`), null, TARGET)).toBeNull();
    expect(seen).toEqual([]);
  });

  it("refuses every path and method but the sign-in legs, without calling InferLab", async () => {
    const seen = upstream();
    for (const [method, path] of [
      ["GET", "/workspaces"], ["GET", "/auth/token"], ["POST", "/auth/token"], ["POST", "/authorize"],
      ["GET", "/authorize/persona"], ["GET", "/authorize/"], ["DELETE", "/logout"],
      ["GET", "/auth/oauth/sign-in/social"], ["POST", "/auth/oauth/callback/google"],
      ["GET", "/auth/oauth/callback/github"], ["POST", "/auth/oauth/sign-out"], ["GET", "/auth/oauth/get-session"],
      ["POST", "/auth/refresh"], ["POST", "/auth/logout"],
    ]) {
      const response = await handleInferLabAuthProxy(new Request(`${PROXY}${path}`, { method }), PROXY, TARGET);
      expect(response?.status, `${method} ${path}`).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it("forwards /authorize with its query and the edge header, never following a redirect", async () => {
    const seen = upstream();
    const response = await handleInferLabAuthProxy(new Request(`${PROXY}/authorize?client_id=inferos&state=x`, {
      headers: { accept: "text/html", "x-forwarded-for": "1.2.3.4", "cf-access-jwt-assertion": "jwt" },
    }), PROXY, TARGET);
    expect(await response?.text()).toBe("page");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${AUTH}/authorize?client_id=inferos&state=x`);
    expect(seen[0].headers.get(INFERLAB_EDGE_HEADER)).toBe(SECRET);
    expect(seen[0].headers.get(AUTHORIZE_ORIGIN_HEADER)).toBe(PROXY);
    expect(seen[0].headers.get("accept")).toBe("text/html");
    expect(seen[0].headers.has("x-forwarded-for")).toBe(false);
    expect(seen[0].headers.has("cf-access-jwt-assertion")).toBe(false);
    expect(seen[0].redirect).toBe("manual");
  });

  it("drops Access's cookie, rewrites Origin and Referer to InferLab, and forwards the form body", async () => {
    const seen = upstream(() => new Response(null, { status: 302, headers: { location: CALLBACK } }));
    const response = await handleInferLabAuthProxy(new Request(`${PROXY}/authorize/persona`, {
      method: "POST",
      headers: {
        cookie: "CF_Authorization=access-jwt; iex_authz_csrf=abc", origin: PROXY,
        referer: `${PROXY}/authorize?client_id=inferos`, "content-type": "application/x-www-form-urlencoded",
      },
      body: "persona=grokbot-owner&csrf=abc",
    }), PROXY, TARGET);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.get("cookie")).toBe("iex_authz_csrf=abc");
    expect(seen[0].headers.get("origin")).toBe(AUTH);
    expect(seen[0].headers.get("referer")).toBe(`${AUTH}/authorize?client_id=inferos`);
    expect(seen[0].body).toBe("persona=grokbot-owner&csrf=abc");
    // The callback is the deployment's own: passed through untouched.
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(CALLBACK);
  });

  it("forwards the Google sign-in start, naming this origin, and passes Google's URL back", async () => {
    const google = "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=x";
    const seen = upstream(() => {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "__Secure-iex_ba.state=s; Path=/; Domain=inferlab.example; HttpOnly; Secure");
      return new Response(JSON.stringify({ url: google, redirect: true }), { headers });
    });
    const body = JSON.stringify({ provider: "google", callbackURL: "/authorize?client_id=inferos" });
    const response = await handleInferLabAuthProxy(new Request(`${PROXY}/auth/oauth/sign-in/social`, {
      method: "POST",
      headers: { origin: PROXY, "content-type": "application/json", "x-inferos-authorize-origin": "https://evil.example" },
      body,
    }), PROXY, TARGET);
    expect(seen[0].url).toBe(`${AUTH}/auth/oauth/sign-in/social`);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].body).toBe(body);
    expect(seen[0].headers.get("origin")).toBe(AUTH);
    // The browser cannot choose the origin InferLab is told about: the proxy always names itself.
    expect(seen[0].headers.get(AUTHORIZE_ORIGIN_HEADER)).toBe(PROXY);
    expect(await response?.json()).toEqual({ url: google, redirect: true });
    expect(response?.headers.getSetCookie()).toEqual(["__Secure-iex_ba.state=s; Path=/; HttpOnly; Secure"]);
  });

  it("forwards Google's callback with its query and keeps the return on the authorize host", async () => {
    const seen = upstream(() => new Response(null, {
      status: 302, headers: { location: `${PROXY}/authorize?client_id=inferos&state=s` },
    }));
    const response = await handleInferLabAuthProxy(
      new Request(`${PROXY}/auth/oauth/callback/google?code=g&state=st`, { headers: { cookie: "__Secure-iex_ba.state=s" } }),
      PROXY, TARGET);
    expect(seen[0].url).toBe(`${AUTH}/auth/oauth/callback/google?code=g&state=st`);
    expect(seen[0].headers.get("cookie")).toBe("__Secure-iex_ba.state=s");
    expect(seen[0].headers.get(AUTHORIZE_ORIGIN_HEADER)).toBe(PROXY);
    expect(response?.headers.get("location")).toBe(`${PROXY}/authorize?client_id=inferos&state=s`);
  });

  it("passes a foreign Origin unchanged, so central-auth still refuses it", async () => {
    const seen = upstream();
    await handleInferLabAuthProxy(new Request(`${PROXY}/authorize/persona`, {
      method: "POST", headers: { origin: "https://evil.example" }, body: "persona=x",
    }), PROXY, TARGET);
    expect(seen[0].headers.get("origin")).toBe("https://evil.example");
  });

  it("keeps a relative redirect from /logout on the authorize host", async () => {
    upstream(() => new Response(null, {
      status: 302, headers: { location: "/authorize?client_id=inferos&state=s" },
    }));
    const response = await handleInferLabAuthProxy(
      new Request(`${PROXY}/logout?return=${encodeURIComponent("/authorize?client_id=inferos&state=s")}`), PROXY, TARGET);
    expect(response?.headers.get("location")).toBe(`${PROXY}/authorize?client_id=inferos&state=s`);
  });

  it("keeps InferLab redirects and cookies on the authorize host", async () => {
    upstream(() => {
      const headers = new Headers({ location: `${AUTH}/authorize?client_id=inferos` });
      headers.append("set-cookie", "iex_sso=r; Path=/; Domain=inferlab.example; HttpOnly; Secure; SameSite=Lax");
      headers.append("set-cookie", "iex_authz_csrf=; Path=/authorize; Max-Age=0");
      return new Response(null, { status: 302, headers });
    });
    const response = await handleInferLabAuthProxy(new Request(`${PROXY}/logout?return=/`), PROXY, TARGET);
    expect(response?.headers.get("location")).toBe(`${PROXY}/authorize?client_id=inferos`);
    expect(response?.headers.getSetCookie()).toEqual([
      "iex_sso=r; Path=/; HttpOnly; Secure; SameSite=Lax",
      "iex_authz_csrf=; Path=/authorize; Max-Age=0",
    ]);
  });
});
