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
3. **`router`**, which binds the backend and every gatekeeper, and is the only worker with a hostname: the stage's, as a custom domain. Every other worker has `workers_dev: false` and `preview_urls: false`, and the deploy checks Wrangler reported no other URL.

The bindings, each gatekeeper's `BASE_URL` and the Context gatekeeper's `sharingDomain` are built by the same functions a per-PR preview uses (`scripts/preview/staging-config.ts`). A stage needs no preview ids: a service binding names a worker, and each tier only has to exist before the next binds it.

KV namespaces (`inferos-<stage>-<package>-<binding>`) are created when missing. The R2 bucket (`inferos-<stage>-<binding>`) and every Durable Object are kept across deploys.

## Before the first deploy

1. **Account.** The account holding the `factorylevel.dev` zone, on Workers Paid. Nothing may already use the stage hostname as a DNS record or another Worker's custom domain.
2. **Access application** for the hostname (Zero Trust, Access, Applications, Self-hosted), created **before** the first deploy so the hostname is never reachable without it, with an Allow policy for the people who may reach the stage. The deploy can't create it. It checks afterwards that an unauthenticated request is redirected to Access, and fails loudly if not.
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

   No secret value is written into a config or printed: the backend's secrets go up with its version (`--secrets-file`, a mode-600 file in a temporary directory, removed afterwards).

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
3. **Accept it by hand.** Sign in through Access, choose "Sign in with InferLab", and open a board you hold. A config that validates is not acceptance.
4. **Re-deploying** is the same command.

`pnpm stage:config <stage>` checks the Wrangler login reaches the account and lists which KV namespaces exist. When all exist, it writes the configs without deploying.

## Rollback

`pnpm exec wrangler rollback --name inferos-<stage>-<package>` returns one worker to an earlier version. Roll the router, backend and gatekeepers back as one compatible set, then check the Access redirect. A rollback never undoes a Durable Object migration.

## What changed from the archived stage deploy

The clean line's gatekeepers and backend differ from the archived `main`, so these archived pieces have nothing to configure here, and dev-os depends on some of them:

- **The InferOps gatekeeper is two:** `gatekeeper-inferlab` and `gatekeeper-inferlabops`, in place of `gatekeeper-inferops`. Their Durable Objects are new, so nothing in the archived `inferos-dev-gatekeeper-inferops` carries over.
- **No sign-in proxy.** The archived `auth.dev-os.factorylevel.dev` (`auth-proxy.ts`, `INFERLAB_AUTHORIZE_ORIGIN`) let a browser sign in to dev InferLab from an address its edge doesn't allow. The new gatekeepers send `/authorize` straight to `INFERLAB_AUTH_ORIGIN`.
- **No InferLab edge secret.** The archived `INFEROPS_EDGE_SECRET` / `x-inferos-edge`, which dev InferLab's Cloud Armor lets through, isn't read or sent.
- **No `internal` company.** `INFEROPS_COMPANY` must be a tenant id.
- **No model bounds.** The backend no longer reads `MODEL_ALLOWLIST` or `DAILY_AGENT_TURN_LIMIT`.
- **Not ported:**
  - `stage:delete`;
  - the post-deploy smoke through an Access service token;
  - the InferOps pin and board-schema gate;
  - a company wrapper's deploy (`inferos:deploy`);
  - company storage.

## Limits

- No CI job deploys a stage, and two people deploying one stage at once are not prevented.
- A passing dry run proves the plan, not a deployed instance.
