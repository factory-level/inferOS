// The deployment settings the InferLab operations connection reads (FAC-235), each parsed so that
// anything unexpected turns the connection off with a reason, instead of sending a person's code
// or token somewhere else or admitting another company. No fallback: no default origin, company
// or base URL, and no demo company.
//
// The origin rule is the InferLab contract's issuer rule, the one gatekeeper-inferlab (FAC-214)
// applies to sign-in; a test checks the two are identical, so they can't drift.

import { type InferLabTarget, edgeSecretOf } from "@gadgets/gatekeeper-kit/inferlab-edge";

/** The InferLab contract's issuer rule (`inferlab.stable-subject` v1), as gatekeeper-inferlab has it. */
export const ISSUER_PATTERN =
  /^(?:https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?)$/;
export const ISSUER_MAX_LENGTH = 255;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The path InferOps central-auth registers for this connection: inferops
 * `INFEROS_OPERATIONS_CALLBACK_PATH` (`domain/ts/portal/shared/sso.dto.ts`, inferops#2686). The
 * Workshop routes a gatekeeper at `/gatekeeper/<name>`, so BASE_URL must end in this package's
 * route for the redirect to be it.
 */
export const GATEKEEPER_PATH = "/gatekeeper/inferlabops";
export const OPERATIONS_CALLBACK_PATH = `${GATEKEEPER_PATH}/oauth`;

/** The settings this file reads. */
export type OperationsEnv = {
  INFERLAB_AUTH_ORIGIN?: string; INFEROPS_COMPANY?: string; BASE_URL?: string;
  INFERLAB_AUTHORIZE_ORIGIN?: string; INFEROPS_EDGE_SECRET?: string;
};

/** What the connection runs with, once every setting is valid. */
export type OperationsConfig = {
  /**
   * The central-auth origin: where the person connects, where tokens are exchanged and refreshed,
   * and the InferOps API the connection reads (the API serves central-auth on its own origin).
   */
  origin: string;
  /** The one company this deployment serves, lowercased. */
  tenantId: string;
  /** This gatekeeper's base URL, without a trailing slash. */
  baseUrl: string;
  /**
   * The dev sign-in proxy's origin (FAC-296), where the browser is sent to connect, or null to send
   * it to `origin`. gatekeeper-inferlab serves it; never `origin` itself.
   */
  authorizeOrigin: string | null;
  /** InferLab's edge secret, sent to `origin` only; undefined when the deployment has none. */
  edge?: string;
};

/** Why the connection is off, in words an administrator can act on. Names settings, never values. */
export const NOT_CONFIGURED = {
  origin: "InferLab operations is off: INFERLAB_AUTH_ORIGIN is missing or isn't an https origin " +
    "(or an http loopback origin for local development).",
  company: "InferLab operations is off: INFEROPS_COMPANY is missing or isn't a tenant id.",
  baseUrl: "InferLab operations is off: BASE_URL is missing, isn't https (or http on a loopback " +
    `host), or doesn't end in ${GATEKEEPER_PATH}.`,
  authorizeOrigin: "InferLab operations is off: INFERLAB_AUTHORIZE_ORIGIN is set but isn't an https " +
    "origin other than INFERLAB_AUTH_ORIGIN.",
} as const;

/** A bare origin under the contract's issuer rule. Anything else is null. */
export function parseOrigin(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || value.length > ISSUER_MAX_LENGTH || !ISSUER_PATTERN.test(value)) return null;
  try {
    return new URL(value).origin === value ? value : null;
  } catch {
    return null;
  }
}

/** BASE_URL, required: https, or http on a loopback host, ending exactly in the gatekeeper's route. */
function parseBaseUrl(raw: string | undefined): string | null {
  const value = raw?.trim().replace(/\/+$/, "");
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== GATEKEEPER_PATH) return null;
  return `${url.origin}${url.pathname}`;
}

/** The deployment's settings, or the first reason the connection is off. */
export function readConfig(env: OperationsEnv): OperationsConfig | { off: string } {
  const origin = parseOrigin(env.INFERLAB_AUTH_ORIGIN);
  if (!origin) return { off: NOT_CONFIGURED.origin };
  const company = env.INFEROPS_COMPANY?.trim() ?? "";
  if (!TENANT_ID.test(company)) return { off: NOT_CONFIGURED.company };
  const baseUrl = parseBaseUrl(env.BASE_URL);
  if (!baseUrl) return { off: NOT_CONFIGURED.baseUrl };
  // A set but malformed proxy origin turns the connection off rather than quietly skipping it.
  let authorizeOrigin: string | null = null;
  if (env.INFERLAB_AUTHORIZE_ORIGIN?.trim()) {
    authorizeOrigin = parseOrigin(env.INFERLAB_AUTHORIZE_ORIGIN);
    if (!authorizeOrigin || authorizeOrigin === origin) return { off: NOT_CONFIGURED.authorizeOrigin };
  }
  const edge = edgeSecretOf(env);
  return { origin, tenantId: company.toLowerCase(), baseUrl, authorizeOrigin, ...(edge ? { edge } : {}) };
}

/** Where calls to InferLab and InferOps go: the origin, with the edge secret when there is one. */
export const inferLabTarget = (config: OperationsConfig): InferLabTarget =>
  ({ origin: config.origin, ...(config.edge ? { edge: config.edge } : {}) });

/** The exact redirect URI InferOps must have registered for the `inferos` client. */
export const redirectUriFor = (config: OperationsConfig): string => `${config.baseUrl}/oauth`;

// ── Event destinations (FAC-236) ───────────────────────────────────────────────────────────────

/**
 * Where InferOps delivers this deployment's committed events: `<BASE_URL>/events/<key>`, one path
 * per destination key, so the secret that checks a delivery is chosen before its body is read.
 */
export const EVENTS_PATH = "events";

/** The contract's destination key rule (`inferlab.callback-destination` v1). */
export const DESTINATION_KEY = /^[a-z][a-z0-9-]{1,62}$/;
/** The shortest signing secret accepted: 32 characters. */
export const MIN_SECRET_LENGTH = 32;

/**
 * One configured event destination: the key InferOps names it by, the one workspace of this
 * deployment's company whose events it carries, and the secret InferOps signs them with. The same
 * key, workspace and secret are configured on the InferOps side (its callback destination).
 */
export type EventDestination = { key: string; workspaceId: string; secret: string };

/** The setting this part reads. */
export type EventsEnv = { INFERLAB_EVENT_DESTINATIONS?: string };

/**
 * What `INFERLAB_EVENT_DESTINATIONS` says: `unset` (no destinations, on purpose); `invalid` (set, but
 * a malformed entry, a repeated key or a short secret turns every destination off, so nothing is
 * accepted under a configuration nobody meant); or the destinations. Never logged.
 */
export type DestinationsState =
  | { state: "unset" } | { state: "invalid" } | { state: "ok"; destinations: Map<string, EventDestination> };

/** `INFERLAB_EVENT_DESTINATIONS`: a JSON array of `{key, workspaceId, secret}`, read whole. */
export function readDestinationsState(env: EventsEnv): DestinationsState {
  const raw = env.INFERLAB_EVENT_DESTINATIONS?.trim();
  if (!raw) return { state: "unset" };
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    return { state: "invalid" };
  }
  if (!Array.isArray(entries) || entries.length === 0) return { state: "invalid" };
  const destinations = new Map<string, EventDestination>();
  for (const entry of entries) {
    const { key, workspaceId, secret } = (entry ?? {}) as Record<string, unknown>;
    if (typeof key !== "string" || !DESTINATION_KEY.test(key) || destinations.has(key)) return { state: "invalid" };
    if (typeof workspaceId !== "string" || !TENANT_ID.test(workspaceId)) return { state: "invalid" };
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) return { state: "invalid" };
    destinations.set(key, { key, workspaceId: workspaceId.toLowerCase(), secret });
  }
  return { state: "ok", destinations };
}

/** The configured destinations: empty unless `INFERLAB_EVENT_DESTINATIONS` is set and valid. */
export function readDestinations(env: EventsEnv): Map<string, EventDestination> {
  const read = readDestinationsState(env);
  return read.state === "ok" ? read.destinations : new Map();
}

/** Whether some destination carries `workspaceId`'s events: what a hook on it needs to fire. */
export const receivesEventsFor = (env: EventsEnv, workspaceId: string): boolean =>
  [...readDestinations(env).values()].some(d => d.workspaceId === workspaceId.toLowerCase());
