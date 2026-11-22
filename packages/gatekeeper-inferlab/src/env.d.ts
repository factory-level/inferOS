// Project-specific Env augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    /**
     * The origin of the InferLab central-auth deployment people sign in through: the subjects'
     * issuer. https, or http on a loopback host for local development. Unset or malformed: no
     * sign-in.
     */
    INFERLAB_AUTH_ORIGIN?: string;
    /** The tenant id of the one company this deployment serves. Unset or malformed: no sign-in. */
    INFEROPS_COMPANY?: string;
    /** This gatekeeper's public base URL; its `/oauth` is the redirect URI InferLab registers. */
    BASE_URL?: string;
    /**
     * Optional, dev only (FAC-296): a second hostname of this deployment that serves InferLab's
     * sign-in pages through this gatekeeper, for browsers InferLab's edge doesn't admit
     * (`@gadgets/gatekeeper-kit/inferlab-edge` `handleInferLabAuthProxy`). It must be behind the
     * deployment's Cloudflare Access application, and InferLab must list it in
     * `auth.sso.proxyOrigins`. Unset: the browser goes to INFERLAB_AUTH_ORIGIN directly.
     */
    INFERLAB_AUTHORIZE_ORIGIN?: string;
    /**
     * Optional secret: the shared value InferLab's edge lets through (`x-inferos-edge`), sent only
     * to INFERLAB_AUTH_ORIGIN. Set it where that edge admits only allowlisted addresses.
     */
    INFEROPS_EDGE_SECRET?: string;
  }
}
