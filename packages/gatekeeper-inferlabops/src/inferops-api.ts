// InferLab central-auth and the InferOps HTTP API, as one person's own connection speaks them
// (FAC-235). Every call carries that person's bearer token and is validated live by InferOps: no
// authority is cached here, and a refused call is reported as the refusal it is.
//
// The request core (bearer plus X-Workspace-Id and X-Idempotency-Key, `redirect: "manual"`, capped
// bodies, field-by-field parsing) is ported from the archived fork's data-connection gatekeeper
// (archive/main-2026-11-14, 24f5d885, http-inferops.ts); see README.md.

import { CredentialsExpiredError } from "@gadgets/gatekeeper-kit/credentials";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";

/** InferLab's registered client id for InferOS: a public client, no secret. */
export const INFERLAB_CLIENT_ID = "inferos";

const TIMEOUT_MS = 30_000;
const LOGOUT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;
const SUBJECT = /^[\x21-\x7e]{1,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION = /^(0|[1-9][0-9]{0,19})$/;

/** What a connection holds: the person's own tokens. Never leaves the account Durable Object. */
export type Grant = {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms the access token expires, from its own `exp`; 0 when it names none. */
  accessExpiresAt: number;
};

/** Who connected: their stable subject and company. Not a credential. */
export type Identity = { issuer: string; subject: string; tenantId: string };

/** A failure whose message is safe to show the person connecting. */
export class ConnectFailure extends Error {}

/** InferOps' answer for a session in another company than this deployment's. */
const COMPANY_NOT_THIS_DEPLOYMENT = "company_not_this_deployment";
export const OTHER_COMPANY =
  "This InferOS belongs to another company. In InferLab, choose the company this InferOS is for, " +
  "then connect again.";

/** An InferOps refusal or failure: its HTTP status and, when it sent one, its error code. */
export class InferOpsApiError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) {
    super(message);
    this.name = "InferOpsApiError";
  }
}

/** Epoch ms of a JWT's `exp`, read without verifying (InferOps verifies; this only schedules a refresh). */
export function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function fetchInit(init: RequestInit, timeoutMs = TIMEOUT_MS): RequestInit {
  // A redirect would carry a code or a token somewhere else.
  return { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) };
}

function errorCodeOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return null;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error === "string") return error;
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/** Exchanges an authorization code for the person's own tokens, never following a redirect. */
export async function exchangeCode(origin: string, code: string, codeVerifier: string,
                                   redirectUri: string): Promise<{ grant: Grant; identity: Identity }> {
  const response = await fetch(`${origin}/auth/token`, fetchInit({
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ clientId: INFERLAB_CLIENT_ID, code, codeVerifier, redirectUri }),
  }));
  const body = await readTextCapped(response, MAX_BODY_BYTES);
  if (!response.ok) {
    if (response.status === 403 && errorCodeOf(body) === COMPANY_NOT_THIS_DEPLOYMENT) {
      throw new ConnectFailure(OTHER_COMPANY);
    }
    // The body may echo request details; never show it.
    throw new ConnectFailure(`InferLab refused the connection (HTTP ${response.status}).`);
  }
  let parsed: { token?: unknown; refreshToken?: unknown; user?: { id?: unknown; tenantId?: unknown } };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new ConnectFailure("InferLab returned an unreadable response.");
  }
  const user = parsed.user ?? {};
  if (typeof parsed.token !== "string" || !parsed.token ||
      typeof parsed.refreshToken !== "string" || !parsed.refreshToken ||
      typeof user.id !== "string" || !SUBJECT.test(user.id) ||
      typeof user.tenantId !== "string" || !UUID.test(user.tenantId)) {
    throw new ConnectFailure("InferLab returned an incomplete response.");
  }
  return {
    grant: { accessToken: parsed.token, refreshToken: parsed.refreshToken, accessExpiresAt: tokenExpiry(parsed.token) },
    identity: { issuer: origin, subject: user.id, tenantId: user.tenantId.toLowerCase() },
  };
}

/**
 * Rotates the person's tokens (`POST /auth/refresh`, which rotates both). A 401 means InferLab has
 * ended the session (signed out everywhere, revoked, expired, or another company now): the grant is
 * dead, reported as `CredentialsExpiredError` so the Workshop asks for a reconnect. Anything else
 * (an outage, a timeout, a 5xx) travels unchanged and kills nothing.
 */
export async function refreshGrant(origin: string, current: Grant): Promise<Grant> {
  const response = await fetch(`${origin}/auth/refresh`, fetchInit({
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refreshToken: current.refreshToken }),
  }));
  const body = await readTextCapped(response, MAX_BODY_BYTES);
  if (response.status === 401) {
    throw new CredentialsExpiredError("Your InferLab operations connection has ended. Reconnect it in the Workshop.",
      { cause: new InferOpsApiError(401, errorCodeOf(body), "refresh refused") });
  }
  if (!response.ok) throw new InferOpsApiError(response.status, errorCodeOf(body), `InferLab refresh failed (HTTP ${response.status}).`);
  const parsed = JSON.parse(body) as { token?: unknown; refreshToken?: unknown };
  if (typeof parsed.token !== "string" || !parsed.token ||
      typeof parsed.refreshToken !== "string" || !parsed.refreshToken) {
    throw new InferOpsApiError(502, null, "InferLab returned an incomplete refresh.");
  }
  return { accessToken: parsed.token, refreshToken: parsed.refreshToken, accessExpiresAt: tokenExpiry(parsed.token) };
}

/**
 * Ends this connection's own InferLab session (`POST /auth/logout` with its refresh token, which
 * revokes that one session and touches no other). Best effort: the tokens are deleted here either
 * way, so nothing can read with them again.
 */
export async function logout(origin: string, refreshToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/auth/logout`, fetchInit({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    }, LOGOUT_TIMEOUT_MS));
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

/** One InferOps API request as the person: their token, the workspace, an idempotency key for writes. */
export async function apiRequest(origin: string, accessToken: string, path: string, options: {
  method?: "GET" | "POST";
  workspaceId?: string;
  idempotencyKey?: string;
  body?: unknown;
} = {}): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  if (options.workspaceId) headers["X-Workspace-Id"] = options.workspaceId;
  if (options.idempotencyKey) headers["X-Idempotency-Key"] = options.idempotencyKey;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${origin}${path}`, fetchInit({
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  }));
  const body = await readTextCapped(response, MAX_BODY_BYTES);
  if (!response.ok) {
    // Never the body: it may name records the caller can't see.
    throw new InferOpsApiError(response.status, errorCodeOf(body), `InferOps answered HTTP ${response.status}.`);
  }
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    throw new InferOpsApiError(502, null, "InferOps returned an unreadable response.");
  }
}

// ── Parsing, field by field: nothing InferOps adds later reaches a Gadget unread. ──

export type Ref = { v: 1; tenantId: string; kind: "project/project" | "project/location"; id: string };
export type ProjectRecord = { ref: Ref; key: string; name: string; revision: string };
export type LocationRecord = {
  ref: Ref; project: Ref; name: string; review: { status: "none" | "requested" }; revision: string;
};

function bad(what: string): never {
  throw new InferOpsApiError(502, null, `InferOps returned a malformed ${what}.`);
}

function refOf(value: unknown, kind: Ref["kind"]): Ref {
  const r = (value ?? {}) as Record<string, unknown>;
  if (r.v !== 1 || r.kind !== kind || typeof r.tenantId !== "string" || !UUID.test(r.tenantId) ||
      typeof r.id !== "string" || !UUID.test(r.id)) bad("reference");
  return { v: 1, tenantId: (r.tenantId as string).toLowerCase(), kind, id: (r.id as string).toLowerCase() };
}

function revisionOf(value: unknown): string {
  return typeof value === "string" && REVISION.test(value) ? value : bad("revision");
}

export function projectOf(value: unknown): ProjectRecord {
  const p = (value ?? {}) as Record<string, unknown>;
  if (typeof p.key !== "string" || typeof p.name !== "string") bad("project");
  return { ref: refOf(p.ref, "project/project"), key: p.key as string, name: p.name as string, revision: revisionOf(p.revision) };
}

export function locationOf(value: unknown): LocationRecord {
  const l = (value ?? {}) as Record<string, unknown>;
  const status = (l.review as { status?: unknown } | undefined)?.status;
  if (typeof l.name !== "string" || (status !== "none" && status !== "requested")) bad("location");
  return {
    ref: refOf(l.ref, "project/location"),
    project: refOf(l.project, "project/project"),
    name: l.name as string,
    review: { status: status as "none" | "requested" },
    revision: revisionOf(l.revision),
  };
}

export function locationPageOf(value: unknown): { items: LocationRecord[]; nextCursor?: string } {
  const page = (value ?? {}) as { items?: unknown; nextCursor?: unknown };
  if (!Array.isArray(page.items)) bad("location page");
  const nextCursor = page.nextCursor;
  if (nextCursor !== undefined && (typeof nextCursor !== "string" || nextCursor.length > 2048)) bad("cursor");
  return { items: page.items.map(locationOf), ...(nextCursor ? { nextCursor: nextCursor as string } : {}) };
}

/** The person's company and their InferOps workspaces with a live grant, by slug. */
export type Company = { tenantId: string; slug: string; workspaces: { id: string; slug: string }[] };

/**
 * The person's trusted company context (`GET /auth/company`, resolved by InferOps from the
 * session alone) and the slugs of the workspaces they hold a live grant in. A workspace InferOps
 * lists without a grant of theirs is left out.
 */
export async function companyOf(origin: string, accessToken: string): Promise<Company> {
  const [context, listed] = await Promise.all([
    apiRequest(origin, accessToken, "/auth/company"),
    apiRequest(origin, accessToken, "/workspaces"),
  ]);
  const c = (context ?? {}) as { tenantId?: unknown; slug?: unknown; workspaces?: unknown };
  if (typeof c.tenantId !== "string" || !UUID.test(c.tenantId) || typeof c.slug !== "string" ||
      !Array.isArray(c.workspaces)) bad("company context");
  const granted = new Set((c.workspaces as { workspaceId?: unknown; product?: unknown }[])
    .filter(w => w.product === "inferops" && typeof w.workspaceId === "string")
    .map(w => (w.workspaceId as string).toLowerCase()));
  const rows = Array.isArray(listed) ? listed : (listed as { workspaces?: unknown[] } | null)?.workspaces ?? [];
  const workspaces = (rows as { id?: unknown; slug?: unknown; product?: unknown }[])
    .filter(w => w.product === "inferops" && typeof w.id === "string" && typeof w.slug === "string" &&
      granted.has((w.id as string).toLowerCase()))
    .map(w => ({ id: (w.id as string).toLowerCase(), slug: w.slug as string }));
  return { tenantId: (c.tenantId as string).toLowerCase(), slug: c.slug as string, workspaces };
}

/** Whether the person holds `permission` in `workspaceId` now, as InferOps' own guard decides. */
export async function holdsPermission(origin: string, accessToken: string, workspaceId: string,
                                      permission: string): Promise<boolean> {
  const answer = await apiRequest(origin, accessToken,
    `/auth/permissions?permissions=${encodeURIComponent(permission)}`, { workspaceId });
  const decisions = (answer as { decisions?: { permission?: unknown; allowed?: unknown }[] } | null)?.decisions;
  return Array.isArray(decisions) && decisions.some(d => d.permission === permission && d.allowed === true);
}
