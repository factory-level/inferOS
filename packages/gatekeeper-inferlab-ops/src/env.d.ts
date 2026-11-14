// Project-specific Env augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    /**
     * The origin of the InferLab central-auth deployment people connect through, which also serves
     * the InferOps API. https, or http on a loopback host for local development. Unset or
     * malformed: no connection.
     */
    INFERLAB_AUTH_ORIGIN?: string;
    /** The tenant id of the one company this deployment serves. Unset or malformed: no connection. */
    INFEROPS_COMPANY?: string;
    /** This gatekeeper's public base URL; its `/oauth` is the redirect URI InferOps registers. */
    BASE_URL?: string;
  }
}
