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
    /**
     * The event destinations InferOps delivers committed events to (FAC-236): a JSON array of
     * `{key, workspaceId, secret}`, a secret. Unset or malformed: no event is accepted and no hook
     * can be subscribed.
     */
    INFERLAB_EVENT_DESTINATIONS?: string;
  }
}
