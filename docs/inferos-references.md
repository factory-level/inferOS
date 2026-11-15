# Opening InferOS from InferMind (FAC-232)

InferMind links to InferOS resources by their canonical InferOps address. InferOS opens such a link
natively: the address says where to go, and InferOS's own open decides who may see it. This page
covers the three InferOS pieces: the `/open/*` routes, the shell's framing policy, and the bundled
Review Alerts blueprint.

## References open natively

| Link | Address (`ref`) | Opens |
| --- | --- | --- |
| `<origin>/open/gadget?ref=…` | `inferops://<company>.<workspace>/inferos/gadget/<workspaceDoId>.<gadgetId>` | `/workspace/<workspaceDoId>?w=<gadgetId>` |
| `<origin>/open/blueprint?ref=…` | `inferops://<company>.<workspace>/inferos/blueprint/<blueprintId>` | `/blueprint/<blueprintId>` |

- `workspaceDoId` is the workspace's Overseer Durable Object id, 64 lowercase hex digits (what
  `WorkspaceMetadata.id` holds). `gadgetId` is the gadget's decimal `WorkpieceId`.
- **A locator, never a grant.** The routes (`packages/workshop-frontend/src/routes/open.*.tsx`)
  parse `ref` with `features/open-reference/inferosReference.ts` and redirect, replacing the
  history entry, to the native route built from the parsed fields. Nothing else from the URL is
  navigated to. The native route then authorizes as it always does: the owner opens the gadget;
  anyone else gets the existing open-failure page (`WorkspaceOpenErrorPage`: "You don't have access
  to this workspace", or "Workspace not found"). A signed-out person gets the sign-in page at the
  native URL, and signing in opens it there.
- **Strict.** Accepted: exactly the two forms above, labels `[a-z0-9-]`, a blueprint id
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, at most 512 characters. Refused: user info, a port, a query,
  a fragment, percent-escapes, extra segments, the other route's kind, and anything else. A refused
  link shows "This link isn't an InferOS reference InferOS can open" with a link home, signed in or
  not, and never echoes the address.
- The company and workspace labels are parsed but not used to open anything: InferOS does not
  check them against the workspace. They name where the reference came from.

## Framing policy

InferOS may be framed only by itself. Every shell page and asset carries:

```
Content-Security-Policy: frame-ancestors 'self'
X-Frame-Options: SAMEORIGIN
```

- **Where it is applied.** `packages/workshop-frontend/public/_headers`, which the build copies into
  `dist/`. Workers Static Assets reads it wherever that build is served: the router's `ASSETS`
  binding when deployed (most paths never run the router: `run_worker_first` covers only `/api`,
  `/blueprint-screenshot` and `/gatekeeper/*`), and the backend's static assets in `pnpm run-local`,
  which the dev router forwards to. The router also adds the same headers to the asset responses
  it returns itself (`packages/router/src/frame-policy.ts`), without weakening a stricter policy;
  its test holds the two copies in step.
- **Not applied** to `/api`, `/blueprint-screenshot/*` or `/gatekeeper/*` (the gatekeeper connect
  pages keep their own `frame-ancestors 'none'`), nor in `pnpm dev-client`'s Vite server on :3000.
- **Gadget frames are unaffected.** Gadget, resource configurator and gatekeeper app frames are
  `srcdoc` frames inside the shell, which load no document a header could reach.

## Review Alerts

A bundled blueprint, `inferlab.review-alerts`
(`packages/bundled-blueprints/blueprints/review-alerts/`), that shows the Locations of one InferOps
Project that are waiting for review. Like every bundled blueprint it is installed on the first
`/api` request and offered as a standard output format ("Review Alerts", icon `listChecks`).

- **One binding, `PROJECT`**: a gatekeeper binding to InferLab operations
  (`gatekeeperName: "inferlabops"`, pattern `inferops://*.*/project/project/*`). The installer
  connects their own account and Project; the blueprint suggests none.
- **The server reads live and keeps nothing.** `getReviewAlerts()` reads the Project and pages its
  Locations (100 a page, at most 20 pages, `incomplete` past that) and returns those whose review is
  `requested`. Unbound, it answers "Not connected: connect an InferLab operations Project", never
  an empty list. A refusal is named (`NotFound`, `Forbidden`, `ConnectionExpired`, ...) with a
  message of its own, never the error's text.
- **The client** draws loading, not connected, failed, empty ("No Locations are waiting for
  review") and the list, as text only.
- **Fresh instantiation** is proved in
  `packages/integration-tests/__tests__/review-alerts-instantiation.test.ts`: each install is a new
  workspace, bound only to the connection that install made on the installer's own account, with
  no hook, an empty store, and `upstream` naming the blueprint and its release.
- The kernel does not check an assignment's vendor against a binding's `gatekeeperName`
  (`AuthenticatedApi.newWorkspaceFromBlueprint`), so the picker is what keeps `PROJECT` an InferLab
  operations connection.
