// The framing policy the router puts on the shell's asset responses. A module of its own because a
// Worker's entry module treats each named export as a possible entrypoint.

/**
 * The framing policy of the shell: InferOS may be framed only by itself, never by another origin
 * (FAC-232). Gadget, configurator and gatekeeper app frames are `srcdoc` frames inside the shell,
 * which no response header reaches.
 *
 * Most shell responses never run this Worker: `run_worker_first` covers only the API, screenshot
 * and gatekeeper prefixes, and Workers Static Assets serves every other path itself. Those carry
 * the same headers from `packages/workshop-frontend/public/_headers`, which the build copies into
 * the assets directory; this copy covers the asset responses the Worker itself returns (a
 * worker-first path no binding claimed). The router's test holds the two in step.
 */
export const FRAME_POLICY_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'self'",
  "X-Frame-Options": "SAMEORIGIN",
} as const;

/**
 * `response` with the framing policy added, never weakened: a response that already restricts its
 * framers keeps its own rule, and a policy without `frame-ancestors` gains a second policy header,
 * which a browser enforces alongside the first.
 */
export function withFramePolicy(response: Response): Response {
  const framed = new Response(response.body, response);
  const policy = framed.headers.get("Content-Security-Policy");
  if (policy === null || !/(^|[;,]\s*)frame-ancestors\b/i.test(policy)) {
    framed.headers.append("Content-Security-Policy", FRAME_POLICY_HEADERS["Content-Security-Policy"]);
  }
  if (!framed.headers.has("X-Frame-Options")) {
    framed.headers.set("X-Frame-Options", FRAME_POLICY_HEADERS["X-Frame-Options"]);
  }
  return framed;
}
