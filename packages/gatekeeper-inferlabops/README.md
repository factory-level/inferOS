# gatekeeper-inferlabops

InferLab operations (FAC-235) is a person's own, explicit connection to their InferOps records. It lets their Gadgets read one Project and its Locations, and request reviews, with exactly that person's InferOps authority.

Signing in to InferOS is `gatekeeper-inferlab` (FAC-214). Sign-in grants nothing and never creates this connection: the person connects it as a separate step.

## What it does

- **Connect.** It runs an authorization code + PKCE flow at `INFERLAB_AUTH_ORIGIN` for the `inferos` client, with the account chooser kept (`prompt=select_account`).
  - It returns to `<BASE_URL>/oauth` = `/gatekeeper/inferlabops/oauth`. That is inferops `INFEROS_OPERATIONS_CALLBACK_PATH` (inferops#2686), which carries the same whole-URL match and company binding as sign-in.
  - InferOps refuses a session in another company than the one the InferOS origin names (ADR 0009 T6). The gatekeeper also re-checks the company against `INFEROPS_COMPANY`.
- **Tokens.** The person's own access and refresh tokens live only in their `OperationsAccount` Durable Object, under the kit's `CredentialCoordinator`.
  - A token is never put in a URL, a log or the Workshop. A facet gets a short-lived access token for one call.
  - Refresh rotates both tokens (`POST /auth/refresh`). A 401 there means InferLab ended the session; the Workshop is told once (`credentialsExpired`) and reads answer `ConnectionExpired`.
- **Binding.** One binding is one Project: `inferops://<company>.<workspace>/project/project/<id>`. The address names, but grants nothing. Checked live with the person's token:
  - the company must be theirs (`GET /auth/company`), and the one this connection was made in;
  - the workspace must be one they hold a grant in;
  - the Project must be one they can read.
- **Session** (`types.d.ts`):
  - `getProject` (`project.read`), `listLocations` (`location.list`) and `getLocation` (`location.read`) are observations. A Location outside the bound Project is `NotFound`.
  - `requestReview` is an approved action (`location.request_review`). It carries the expected revision and an `X-Idempotency-Key` made from this binding's own random id and the action id, so a retried action replays and two bindings never share a key. A key InferOps already used for a different request is `IdempotencyConflict`. While it is pending, reads show the Location as `requested`.
- **Live validation.** Nothing is cached. Every call is InferOps' own decision for that person's token now, so a revoked grant stops the next read.

## Access model (observers)

- **Every read reports what it discloses** as subresources:
  - the Project: `tenant/<tenant>/workspace/<workspace>/project/<id>`;
  - each Location: `tenant/<tenant>/workspace/<workspace>/location/<id>`.
  - All of these are marked `containsRestrictedData`.
- **A collaborator is admitted only when their own connection can read every reported resource now**, checked through `OperationsVerifier`: `project.read`/`location.read` with the collaborator's own token.
  - 200 is yes; 403 or 404 is no.
  - An outage or an ended session throws: access can't be determined.
- **The kernel checks recorded requirements again at every later admission.** So a collaborator never inherits what the owner's Gadget read, whether cached or historical.
- **The kernel-required members:** `getHistoricalSubresources()` returns `[]`, and `addObserver`/`removeObserver` are no-ops (new-gatekeeper contract).

## Attention authority (FAC-237)

`InferLabAttentionAuthority` is the `ATTENTION_AUTHORITY` service binding. It answers with each person's own connection, live, found by their stable subject in `SubjectIndex`:

- **`visible(subject, targets)`:** whether the person can read each target now. No connection means false. Only `project/project` and `project/location` targets are checked; other kinds are false.
- **`eligible(intent, candidates)`:** the candidates who hold `audience.permission` in `audience.workspaceId` (`GET /auth/permissions`) and can see the target.
- **`approves(workspace, intent)`:** the target is this deployment's company, and the owner holds a grant in the audience workspace and can see the target.
- **`verifyEvent(workspace, intent)`:** whether `intent.sourceEventId` is an event InferOps really committed, read with the workspace owner's own connection (`GET /project/locations/<id>/events/<eventId>`, inferops#2686). True only when it exists and matches the intent: its resource is the target, its type is the one for the reason (`review_requested` is `project.location.review_requested`), its workspace is the audience's and its company is this deployment's. Not found, any mismatch, an owner with no connection or no grant: false.
- **Indeterminate answers throw**, so nothing is delivered on a guess.

## Events and hooks (FAC-236)

InferOps' committed events reach Gadget server code through the Workshop's own Hook machinery, as every push-driven gatekeeper's do (`ApprovalQueue.bindHook`, `HookController`, `HookInitiator`, and the kit's `HookRegistry`, after `gatekeeper-pagerduty`).

- **Ingress:** `POST <BASE_URL>/events/<key>` (`src/events.ts`). InferOps' dispatch (FAC-234) delivers each committed event there, signed, to each destination of the event's workspace. No browser is involved. In order, each failure refused:

  | Check | Refusal |
  | --- | --- |
  | The receiver is on: the connection settings are valid, and `INFERLAB_EVENT_DESTINATIONS`, if set, is valid. Off by a misconfiguration (a botched secret rotation, say) is retryable, so nothing committed is lost | 503 |
  | `<key>` is a configured destination; its own secret checks the signature | 404 |
  | The body is at most 16 KiB (`MAX_EVENT_BYTES`) | 413 |
  | `x-inferlab-signature` `t=…,v1=…` is HMAC-SHA256 of `<t>.` and the **raw bytes**, compared in constant time, `t` within 300 s of now. Nothing is parsed before this | 401 |
  | The body is UTF-8 JSON: FAC-234's envelope `{v: 1, issuer, destination, tenantId, workspaceId, event}`, and the event is `inferlab.committed-event` v1, checked with the pinned schema's own patterns; `x-inferlab-delivery` is its `eventId`; the resource is a Location | 400 |
  | The scope is the destination's: `issuer` is `INFERLAB_AUTH_ORIGIN`, `destination` is `<key>`, the company is `INFEROPS_COMPANY`, and the workspace (envelope and event) is the destination's one workspace | 403 |

- **Checkpoint and acknowledgement.** The deployment's one `ProjectEventDriver` records the event in one transaction: a checkpoint on its `eventId` (`seen:`, kept 7 days) and one queued delivery per enabled hook that may watch it. Only then does the ingress answer **202** `{accepted, duplicate}`. It doesn't wait for any hook: the kit's queue delivers from the driver's alarm and retries. The same `eventId` again (InferOps retries a timeout with the same id) answers 202 `duplicate: true` and queues nothing, so a hook fires once. Storage is durable, so a restart before delivery still delivers, once.
  - **The alarm is reconciled from what is stored** on every accept and every duplicate, before the answer: due at the next queued delivery, else a later checkpoint sweep, else none. So if the alarm was lost after a commit (an interrupted object, a failed `setAlarm`), the sender's retry restores it. The alarm reconciles again after every run, even a failed one, so it re-arms while work remains.
  - A delivery that can't be recorded answers 503, unacknowledged, and the sender retries it.
- **Subscribing.** A Gadget calls `ProjectSession.subscribe(hook)` with a persistent stub (`types.d.ts`). The facet checks that a destination serves this binding's workspace and that the person can read the Project now. It mints a delivery stub to itself (`ctx.restore`) and binds a `ProjectEventHookController`, whose props carry the binding's company, workspace and Project. The Workshop keeps the hook **disabled until the user enables it**. On enable, the controller registers it with the driver.
- **Delivery.** A hook watches only its own binding's company and workspace (`watches`). The event's own fields only select among hooks whose binding already has them. Each firing goes through the Workshop's `startHook()`, which refuses a disabled or deleted hook. The binding's facet (`ProjectEventDeliveryImpl`) then re-reads the Location **with the connected person's own token, now**:
  - a Location they can't read (403/404), an expired or revoked connection, or another Project's Location is dropped, disclosing nothing;
  - otherwise the firing observes the Project and the Location, and `receiveEvent` gets the event id, type, time, revision, the Location as read, and a `ProjectSession` backed by the firing's approval queue.
- **Raising attention.** The hook runs as the Gadget's own code, so it may raise attention with `env.ATTENTION` (FAC-237), citing `event.eventId` as the source event (see `docs/attention.md`).
- **Disabling and disconnecting.** Disabling a hook removes it and its queued deliveries. Disconnecting (`revoke`) drops every hook of that connection and refuses enabling one again.

## Sign-out and revocation

| What | Effect |
| --- | --- |
| Disconnect in the Workshop (`revoke`) | Drops the connection's event hooks (FAC-236). Deletes every token at once, then always tries both: signing this connection's own InferLab session out (`POST /auth/logout` with its refresh token), and forgetting the connection for the attention authority. A step that fails is reported, both if both fail; the tokens are gone either way, so the next read fails. |
| An InferOps grant revoked | The next call is refused by InferOps (`Forbidden`/`NotFound`). A collaborator who lost access is no longer admitted. |
| InferLab "sign out everywhere", or the session expiring | The next refresh is refused. Reads answer `ConnectionExpired` and the Workshop asks for a reconnect. |

Reconnecting is "disconnect, then connect again". There is no staged reconnect in v1.

## Settings

- `INFERLAB_AUTH_ORIGIN`: required. The central-auth origin, which also serves the InferOps API.
- `INFEROPS_COMPANY`: required. The one company's tenant id.
- `BASE_URL`: set by the dev server and the deployer. It must end in `/gatekeeper/inferlabops`.
- `INFERLAB_EVENT_DESTINATIONS` (FAC-236): a secret. A JSON array of `{key, workspaceId, secret}`, the same key, workspace and secret as the InferOps callback destination that delivers to `<BASE_URL>/events/<key>`. The key follows the contract's rule, the workspace is a tenant id, and the secret is at least 32 characters. Anything malformed turns every destination off. Unset: no event is accepted and no hook can be subscribed.

Each setting fails closed with a reason that names it. There is no default origin or company, no demo company and no password path. `scripts/run-dev-server.ts` passes the first two and `INFERLAB_EVENT_DESTINATIONS` through.

## Port ledger

The donor is the archived fork at `archive/main-2026-11-14` (`24f5d885`), specifically its data-connection gatekeeper package. Files are named by basename; the fence keeps the fork's package name out of this tree.

| File here | Donor file at 24f5d885 | Why | What changed |
| --- | --- | --- | --- |
| `src/account.ts` (`OperationsAccount`) | `src/inferops-credentials.ts` | The CredentialCoordinator wiring, the once-only expiry notice, and revoke (log out, then delete everything) were reviewed and working. | Dropped the wiki search budget, the stored workspace list (now resolved live), staged reconnect, and the system credential lane. Added `canRead`/`holds` probes and the subject index. |
| `src/inferops-api.ts` | `src/http-inferops.ts` (request core and parse helpers) | Bearer plus `X-Workspace-Id`/`X-Idempotency-Key`, `redirect: "manual"`, capped bodies, field-by-field parsing. | New typed calls for Projects, Locations, review requests, company context and permissions, written to the pinned contracts. None of the board, issue or wiki calls. |
| `src/inferops-api.ts` (`exchangeCode`, `refreshGrant`, `logout`) | `src/inferlab-login.ts` (via gatekeeper-inferlab's `token.ts`) | The code exchange and the company refusal. | Keeps the tokens, where sign-in discards them. Refresh classifies a 401 as grant death. |
| `src/worker.ts` (connect attempt, browser legs) | gatekeeper-inferlab `src/worker.ts` (FAC-214) | The same handshake, nonces and PKCE. | Own path and DO names. Refuses `scopes: "auth"`. |
| `src/config.ts` | gatekeeper-inferlab `src/config.ts` | Fail-closed settings. | Own route. The issuer rule is copied, and a test asserts it is identical. |

**Left behind deliberately:** Dot and its relay, host boards, board discovery, the coding workbench, the wiki, tables, members, workflow policy, the mock provider, system credentials, the auth proxy and edge header, the fork's seven facet classes and its legacy observer roster, and every fixture. No Console, Dot or widget kind code is imported; `scripts/inferlab-g0/fence-audit.sh` stays clean.

## Tests

`pnpm --filter @gadgets/gatekeeper-inferlabops test:run` runs the workerd suite in `__tests__/connection.test.ts`. It uses a fake InferOps faked at `fetch` (mock mode, no network) and covers:

- configuration;
- connecting (no sign-in, PKCE, company refusal);
- binding;
- reads and their subresources;
- the grant matrix (observer reads, revoked grant refused at once);
- outages;
- the review action (simulation, idempotency, stale revision, rejection);
- observers (own connection, revoked, outage, foreign ids);
- revoke and expiry;
- the attention authority, including a revoked recipient, and `verifyEvent` on every match point;
- events and hooks (FAC-236):
  - the contract's patterns against the pinned schema, its valid and invalid fixtures, and the destinations setting;
  - every ingress refusal: forged, altered, stale and future signatures; unsigned and forged bodies however malformed; an unknown key, an oversized body, non-JSON, non-UTF-8, and schema- or scope-invalid but signed bodies. None records a checkpoint;
  - a duplicate acknowledged without a second fire;
  - the hook lifecycle: disabled by default, enable, a revoked grant, another Project's Location, a disabled and a deleted hook, a restart before delivery, a slow hook not delaying the acknowledgement, and a disconnect.
