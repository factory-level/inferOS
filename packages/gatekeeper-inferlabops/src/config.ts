// The deployment settings the InferLab operations connection reads (FAC-235), each parsed so that
// anything unexpected turns the connection off with a reason, instead of sending a person's code
// or token somewhere else or admitting another company. No fallback: no default origin, company
// or base URL, and no demo company.
//
// The origin rule is the InferLab contract's issuer rule, the one gatekeeper-inferlab (FAC-214)
// applies to sign-in; a test checks the two are identical, so they can't drift.

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
export const GATEKEEPER_PATH = "/gatekeeper/inferlab-ops";
export const OPERATIONS_CALLBACK_PATH = `${GATEKEEPER_PATH}/oauth`;

/** The settings this file reads. */
export type OperationsEnv = { INFERLAB_AUTH_ORIGIN?: string; INFEROPS_COMPANY?: string; BASE_URL?: string };

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
};

/** Why the connection is off, in words an administrator can act on. Names settings, never values. */
export const NOT_CONFIGURED = {
  origin: "InferLab operations is off: INFERLAB_AUTH_ORIGIN is missing or isn't an https origin " +
    "(or an http loopback origin for local development).",
  company: "InferLab operations is off: INFEROPS_COMPANY is missing or isn't a tenant id.",
  baseUrl: "InferLab operations is off: BASE_URL is missing, isn't https (or http on a loopback " +
    `host), or doesn't end in ${GATEKEEPER_PATH}.`,
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
  return { origin, tenantId: company.toLowerCase(), baseUrl };
}

/** The exact redirect URI InferOps must have registered for the `inferos` client. */
export const redirectUriFor = (config: OperationsConfig): string => `${config.baseUrl}/oauth`;
