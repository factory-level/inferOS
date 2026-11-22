# Deploy a persistent stage

How to deploy and update the two persistent InferOS instances, each behind Cloudflare Access and connected to its own InferLab environment. Ported to this line from the archived `main` (`docs/wiki/stage-deploy.md` there) for FAC-296. What this line does differently is listed under [What changed from the archived stage deploy](#what-changed-from-the-archived-stage-deploy).

| Stage | Hostname | InferLab |
| --- | --- | --- |
| `dev` | `https://dev-os.factorylevel.dev` | `auth.dev.inferlab.io` |
| `prod` | `https://os.factorylevel.dev` | `auth.inferlab.io` |

The stages are declared in `scripts/stage/stages.ts`. Never change a stage's `workerPrefix` or `resourcePrefix` there: the next deploy would create a new, empty instance and abandon the old one.

## What a deploy is

`pnpm stage:deploy <stage>` runs `wrangler deploy` for each worker under a stable, prefixed name (`inferos-<stage>-<package>`), in three tiers:

1. **The stage's gatekeepers**, concurrently: `gatekeeper-inferlab` (InferLab sign-in), `gatekeeper-inferlabops` (InferOps data with the person's own InferLab session), `gatekeeper-context`, `gatekeeper-scheduler` and `gatekeeper-mcp`. The other gatekeepers need OAuth apps a stage doesn't configure, so they are neither deployed nor bound, and the Workshop doesn't offer them.
2. **`workshop-backend`**, which binds each gatekeeper by its stage worker name.
3. **`router`**, which binds the backend and every gatekeeper, and owns the stage's hostname as a custom domain.

Only two workers are reachable. The router has the stage's hostname. On `dev`, `gatekeeper-inferlab` also has the sign-in proxy's hostname (below). Every worker has `workers_dev: false` and `preview_urls: false`, and the deploy checks Wrangler reported no other URL.

The bindings, each gatekeeper's `BASE_URL` and the Context gatekeeper's `sharingDomain` are built by the same functions a per-PR preview uses (`scripts/preview/staging-config.ts`). A stage needs no preview ids: a service binding names a worker, and each tier only has to exist before the next binds it.

KV namespaces (`inferos-<stage>-<package>-<binding>`) are created when missing. The R2 bucket (`inferos-<stage>-<binding>`) and every Durable Object are kept across deploys.

## Before the first deploy

1. **Account.** The account holding the `factorylevel.dev` zone, on Workers Paid. Nothing may already use the stage hostname as a DNS record or another Worker's custom domain.
2. **Access application** for the hostname (Zero Trust, Access, Applications, Self-hosted), created **before** the first deploy so the hostname is never reachable without it, with an Allow policy for the people who may reach the stage. On `dev`, put the sign-in proxy's hostname `auth.dev-os.factorylevel.dev` in the **same** application: it serves InferLab's sign-in pages, including the persona picker. The deploy can't create the application. Afterwards it checks that an unauthenticated request to every stage hostname is redirected to Access, and fails loudly if not.
3. **InferLab registration.** In InferOps' config for that environment (`config/development.js` for `dev`, `config/production.js` for `prod`), the stage origin must be:
   - in `auth.sso.inferosOrigins`;
   - mapped in `auth.sso.inferosCompanies` to a **tenant id**.

   The callbacks are `<origin>/gatekeeper/inferlab/oauth` and `<origin>/gatekeeper/inferlabops/oauth`.
4. **The stage's company** in `scripts/stage/stages.ts` (`inferops.company`): that same tenant id. Both InferLab gatekeepers refuse `INFEROPS_COMPANY = "internal"`. A stage still naming `internal` plans, but its deploy is refused (see below).
5. **Wrangler login:** `pnpm exec wrangler login`.
6. **Inputs,** in the shell or in a gitignored `.stage-<stage>.vars` at the repository root (`KEY=value` lines; the shell wins):

   | Variable | Required | Purpose |
   | --- | --- | --- |
   | `CLOUDFLARE_ACCOUNT_ID` | yes | The account to deploy to. |
   | `STAGE_ADMINS` | yes | Comma-separated emails of the stage's admins (`/admin`). Uploaded as the backend's `ADMINS` secret. |
   | `CF_AI_GATEWAY`, `CF_AI_GATEWAY_ACCOUNT_ID`, `CF_AI_GATEWAY_PROVIDERS`, … | no | Server-managed models through AI Gateway (`resolveAiGateway` in `scripts/preview/staging-config.ts`). Uploaded as backend secrets. Unset, each user brings their own model keys. |
   | `STAGE_ADMIN_CONFIG_SEED` | no | The Models tab the stage starts with (which models it offers, `userModelsEnabled`, …), a JSON object of the backend's `ADMIN_CONFIG_SEED` fields. Uploaded as the backend's `ADMIN_CONFIG_SEED` secret. |
   | `INFEROPS_EDGE_SECRET_<STAGE>` (`_DEV`, `_PROD`) | no (yes for `dev` today) | The shared value InferLab's edge lets through, for **this** stage only: a dev value never deploys to prod. Dev InferLab's Cloud Armor admits only allow-listed addresses, so without it sign-in and every InferOps call from the stage get a 403. Use the same value as InferOps' `waf:inferosEdgeSecret`: at least 32 characters of `A-Za-z0-9_-`. Uploaded as the `INFEROPS_EDGE_SECRET` secret of `gatekeeper-inferlab` and `gatekeeper-inferlabops`, which send it as `x-inferos-edge`, to the InferLab origin only. A bare `INFEROPS_EDGE_SECRET` in the shell names no stage and stops the run. |

   No secret value is written into a config or printed. Each worker's secrets go up with its version (`--secrets-file`, a mode-600 file in a temporary directory, removed afterwards).

## Steps

1. **Rehearse with no network:** `pnpm stage:deploy dev --dry-run`.
   - It prints every worker, its var names, what it binds and the backend's secret names (never values). It also prints the KV namespaces and the bucket.
   - It writes nothing.
   - If the deploy would be refused, the plan ends with a `REFUSED` section saying why.
2. **Deploy:** `pnpm stage:deploy dev`.
   - It builds the workspace (the frontend in non-Access mode), creates any missing KV namespace and writes `wrangler.stage-dev.jsonc` beside each package (gitignored).
   - It deploys the three tiers, then checks the Access redirect on the stage hostname.
   - `dev` refuses a dirty tree unless `--allow-dirty`; `prod` always refuses one.
   - It refuses Durable Object migrations that delete, rename or move a class unless `--allow-destructive-migrations`, because `wrangler rollback` never undoes them.
   - It prints a JSON deploy record: the InferOS commit and the config digest.
3. **Run the smoke by hand.** The deploy's last lines print it:
   1. Open the stage and pass Access.
   2. Choose "Sign in with InferLab" and sign in as a seat of the stage's company. On `dev`, the sign-in page is served from `auth.dev-os.factorylevel.dev`.
   3. Open that company's board.
   4. Open a chat. The model picker should show an agent, and a message should get an answer.

   A config that validates is not acceptance.
4. **Re-deploying** is the same command.

`pnpm stage:config <stage>` checks the Wrangler login reaches the account and lists which KV namespaces exist. When all exist, it writes the configs without deploying.

## Rollback

`pnpm exec wrangler rollback --name inferos-<stage>-<package>` returns one worker to an earlier version. Roll the router, backend and gatekeepers back as one compatible set, then check the Access redirect. A rollback never undoes a Durable Object migration.

## Signing in through dev InferLab's edge

Dev InferLab's edge (Cloud Armor) admits only allow-listed addresses and requests carrying the edge secret, so the clean line's two InferLab gatekeepers handle both cases (`@gadgets/gatekeeper-kit/inferlab-edge`):

- **The browser's sign-in pages: the dev sign-in proxy.** `INFERLAB_AUTHORIZE_ORIGIN` is `https://auth.dev-os.factorylevel.dev`, `gatekeeper-inferlab`'s second custom domain. Both gatekeepers send the browser's `/authorize` there, and the proxy forwards it to InferLab with the edge secret.
  - Only central-auth's browser legs are forwarded: `GET /authorize`, `POST /authorize/persona`, `GET /logout`, and Google's `POST /auth/oauth/sign-in/social` and `GET /auth/oauth/callback/google`.
  - The code, the subject and the session come from InferLab exactly as without the proxy.
  - InferLab answers on the proxy origin only because its `auth.sso.proxyOrigins` lists it, and the Google callback on that origin is registered on InferLab's Google client.
- **The server's calls: the edge secret.** The code exchange, refresh, logout and every InferOps API call go straight to `INFERLAB_AUTH_ORIGIN`, carrying the edge secret.
- **Production has no proxy, structurally.** A stage that deploys only from a clean tree (`prod`) is refused if it names a proxy origin. Its edge secret, if it ever needs one, is its own input, `INFEROPS_EDGE_SECRET_PROD`.

**Rotating the edge secret:** change both values (InferOps' `waf:inferosEdgeSecret` and this stage's `INFEROPS_EDGE_SECRET_<STAGE>`) and redeploy both sides. Requests are refused between the two deploys. Leaving the variable out of a later deploy doesn't delete it, because a deploy without it keeps the previous version's secret. Delete it with `pnpm exec wrangler secret delete INFEROPS_EDGE_SECRET --name inferos-dev-gatekeeper-inferlab`, and the same for `-inferlabops`.

## The spend guard

`dev` declares `agents: { dailyTurnLimit: 40 }` (`scripts/stage/stages.ts`). The backend gets `ENABLE_CLOUDFLARE_LIMITS=true` and `DAILY_LLM_CALL_LIMIT=40`. That sets one counter per workspace owner per UTC day, reset at midnight UTC, with a limit of 40.

**What it counts** (each item is one call):
- **An agent turn,** counted before it starts (`overseer.ts`, `checkUsageAndBalance`). The model steps inside one turn are not counted separately: one turn is one call, however many steps it takes.
- **A Gadget's model-binding call,** made through a binding to one of the stage's own (gateway) models: `LanguageModelBinding.run` or `DecisionModelBinding.decide`. It's counted before the model is called (`ai-gateway-billing/limits/binding-charge.ts`), against the binding's workspace owner, recorded when the binding was made.

Once the day's 40 are used, a turn ends with the reason shown in the chat, and a binding call is refused with the same reason. A binding made before its owner was recorded is refused while the limit is on; bind the model again.

**What it doesn't count:**
- A model a user added with their own key: it costs the platform nothing.
- An agent turn of a user who connected their own funded Cloudflare account: it bills that account (the clean line's billing rule).
- The model steps within one turn, beyond the turn itself (above).
- Anything when `ENABLE_CLOUDFLARE_LIMITS` is off, as on `prod` and every non-stage deployment.

**Which models** the stage offers comes from `STAGE_ADMIN_CONFIG_SEED`, the Models tab it starts with. An admin can change that later in `/admin`. **None of this is a dollar bound:** that's the spend limit on the provider key the AI Gateway stores (the InferOS Anthropic key's is 60 USD a month). The archived stage's `MODEL_ALLOWLIST` and `DAILY_AGENT_TURN_LIMIT` have no reader on this line.

## What changed from the archived stage deploy

The clean line's gatekeepers and backend differ from the archived `main`, so these archived pieces have nothing to configure here, and dev-os depends on some of them:

- **The InferOps gatekeeper is two:** `gatekeeper-inferlab` and `gatekeeper-inferlabops`, in place of `gatekeeper-inferops`. Their Durable Objects are new, so nothing in the archived `inferos-dev-gatekeeper-inferops` carries over.
- **The sign-in proxy and the edge secret** are ported (above), served and sent by both InferLab gatekeepers.
- **No `internal` company.** `INFEROPS_COMPANY` must be a tenant id.
- **The spend guard** is the clean line's own daily limit (above), not `MODEL_ALLOWLIST` or `DAILY_AGENT_TURN_LIMIT`.
- **Not ported:**
  - `stage:delete`;
  - the automated smoke through an Access service token (a person runs it from the deploy's printed steps);
  - the InferOps pin and board-schema gate;
  - a company wrapper's deploy (`inferos:deploy`);
  - company storage.

## Limits

- No CI job deploys a stage, and two people deploying one stage at once are not prevented.
- A passing dry run proves the plan, not a deployed instance.
