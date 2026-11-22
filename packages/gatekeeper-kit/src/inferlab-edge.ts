// Reaching an InferLab environment whose edge admits only known callers (FAC-296 part 2).
//
// Ported from the archived fork's gatekeeper-inferops (`edge-header.ts` and `auth-proxy.ts`, origin/main
// 2ffa24dc5), for the clean line's two InferLab gatekeepers, `gatekeeper-inferlab` (sign-in) and
// `gatekeeper-inferlabops` (InferOps data). Dev InferLab's edge (Cloud Armor) admits only
// allowlisted addresses, plus requests carrying the shared `x-inferos-edge` secret. A hosted
// InferOS Worker calls from Cloudflare's shared egress, and a person's browser from anywhere, so
// neither is allowlisted:
//
// - **The edge header.** {@link inferLabFetch} adds `x-inferos-edge` to requests for the one
//   InferLab origin a gatekeeper is configured with (exact origin), and to nothing else. A request
//   that carries it never follows a redirect, so the header can't travel to wherever a `Location`
//   points. It is an edge credential, not an identity: InferLab's authentication, permissions and
//   RLS apply behind it unchanged. Nothing here logs it, or anything else.
// - **The sign-in proxy.** {@link handleInferLabAuthProxy} serves central-auth's browser legs from a
//   hostname of the deployment (`INFERLAB_AUTHORIZE_ORIGIN`, dev only), forwarding them to the
//   InferLab origin through {@link inferLabFetch}. The person signs in on InferLab's own pages, and
//   the code, the subject and the session come from InferLab exactly as they would without it:
//   - Only the browser legs are forwarded, each with its one method: `GET /authorize`,
//     `POST /authorize/persona`, `GET /logout`, and the Google edge's
//     `POST /auth/oauth/sign-in/social` and `GET /auth/oauth/callback/google`. The InferLab origin
//     also serves the whole API, so every other path is a 404 here.
//   - Every forwarded request names this origin in `x-inferos-authorize-origin`. InferLab answers
//     the Google legs on it only when it is on InferLab's own `auth.sso.proxyOrigins` list, so
//     Google sends the browser back here; for any origin not listed the header is ignored.
//   - Only a fixed set of request headers goes on, with Cloudflare Access's `CF_Authorization`
//     cookie removed. `Origin` and `Referer` naming this origin are rewritten to the InferLab origin
//     so central-auth's same-origin check on the persona form holds; anything else passes unchanged
//     and is refused there as before.
//   - Redirects are never followed. A `Location` on the InferLab origin is rewritten to this origin;
//     any other (the `/oauth` callback on the deployment's own hostname) passes through.
//     `Set-Cookie` loses any `Domain` attribute, so a cookie lands on this host only.
//   - The authorize origin exposes InferLab's sign-in pages (and, on dev, the persona picker), so it
//     must sit behind the deployment's Cloudflare Access application.
//   - The code exchange, refresh and logout never come through here: the gatekeepers call the
//     InferLab origin directly, with the edge header.

/** The request header InferLab's edge allow rule matches (inferops `infra/waf`, `waf:inferosEdgeSecret`). */
export const INFERLAB_EDGE_HEADER = "x-inferos-edge";

/** Names the origin the proxy serves central-auth from (InferLab's `PORTAL_AUTHORIZE_ORIGIN_HEADER`). */
export const AUTHORIZE_ORIGIN_HEADER = "x-inferos-authorize-origin";

/** The edge secret's shape: what InferLab's WAF rule accepts. */
const EDGE_SECRET = /^[A-Za-z0-9_-]{32,}$/;

/** Where an InferLab call goes: its origin, and the edge secret for it when the deployment has one. */
export type InferLabTarget = { origin: string; edge?: string };

/** A bare origin or a target, as the InferLab call helpers accept it. */
export type InferLabOriginLike = string | InferLabTarget;

/** The edge secret from a deployment's environment, or undefined when unset or not its shape. */
export function edgeSecretOf(env: { INFEROPS_EDGE_SECRET?: string }): string | undefined {
  const value = env.INFEROPS_EDGE_SECRET?.trim();
  return value && EDGE_SECRET.test(value) ? value : undefined;
}

/** The origin an InferLab call goes to. */
export function originOf(target: InferLabOriginLike): string {
  return typeof target === "string" ? target : target.origin;
}

function exactOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

/**
 * The `fetch` an InferLab call goes through. With an edge secret it adds {@link INFERLAB_EDGE_HEADER}
 * to requests for the target's origin (and only that one) and never follows a redirect; otherwise it
 * is plain `fetch`. The global is read per call, so a test that stubs it is honoured.
 */
export function inferLabFetch(target: InferLabOriginLike): typeof fetch {
  const secret = typeof target === "string" ? undefined : target.edge;
  const origin = exactOrigin(originOf(target));
  return (input, init) => {
    const to = exactOrigin(requestUrl(input));
    if (!secret || origin === null || to !== origin) return fetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set(INFERLAB_EDGE_HEADER, secret);
    const redirect = init?.redirect === "error" ? "error" : "manual";
    return fetch(input, { ...init, headers, redirect });
  };
}

/** The central-auth paths the proxy forwards, each with the one method it accepts. */
const FORWARDED: ReadonlyMap<string, string> = new Map([
  ["/authorize", "GET"],
  ["/authorize/persona", "POST"],
  ["/logout", "GET"],
  ["/auth/oauth/sign-in/social", "POST"],
  ["/auth/oauth/callback/google", "GET"],
]);

/** Request headers a sign-in page needs; nothing else reaches InferLab. */
const FORWARDED_REQUEST_HEADERS = [
  "accept", "accept-language", "content-type", "cookie", "origin", "referer", "user-agent",
];

/** Cloudflare Access's session cookie for the authorize host: InferLab has no use for it. */
const ACCESS_COOKIE = "CF_Authorization";

function withoutCookie(header: string, name: string): string {
  return header.split(";").map(part => part.trim())
    .filter(part => part && part.split("=")[0]?.trim() !== name).join("; ");
}

function rewriteOrigin(value: string, from: string, to: string): string {
  if (value === from) return to;
  return value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : value;
}

function withoutDomain(setCookie: string): string {
  return setCookie.split(";").filter(part => !/^\s*domain\s*=/i.test(part)).join(";");
}

/**
 * Serves a request addressed to the authorize origin by forwarding it to the InferLab origin, or
 * returns null when the request is for any other origin, or when either origin is missing, invalid
 * or the same as the other. `authorizeOrigin` and `target.origin` must already be parsed origins.
 */
export async function handleInferLabAuthProxy(
  request: Request, authorizeOrigin: string | null, target: InferLabTarget | null,
): Promise<Response | null> {
  const upstream = target?.origin ?? null;
  const url = new URL(request.url);
  if (!authorizeOrigin || !upstream || authorizeOrigin === upstream || url.origin !== authorizeOrigin) {
    return null;
  }
  if (FORWARDED.get(url.pathname) !== request.method) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    let value = request.headers.get(name);
    if (value === null) continue;
    if (name === "cookie") value = withoutCookie(value, ACCESS_COOKIE);
    if (name === "origin" || name === "referer") value = rewriteOrigin(value, authorizeOrigin, upstream);
    if (value) headers.set(name, value);
  }
  headers.set(AUTHORIZE_ORIGIN_HEADER, authorizeOrigin);

  const response = await inferLabFetch(target as InferLabTarget)(`${upstream}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === "POST" ? await request.arrayBuffer() : undefined,
    redirect: "manual",
  });

  const out = new Headers(response.headers);
  const location = out.get("location");
  if (location) {
    let next: URL | null;
    try {
      next = new URL(location, upstream);
    } catch {
      next = null;
    }
    if (next?.origin === upstream) {
      out.set("location", `${authorizeOrigin}${next.pathname}${next.search}${next.hash}`);
    }
  }
  const cookies = response.headers.getSetCookie();
  out.delete("set-cookie");
  for (const cookie of cookies) out.append("set-cookie", withoutDomain(cookie));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}
