// The persistent InferOS stages `pnpm stage:*` deploys (scripts/stage/stage.ts), by name.
//
// Ported to the clean line from the archived main's scripts/stage/stages.ts (FAC-296). What changed
// with the clean line, and why:
// - InferLab sign-in and InferOps data are two gatekeepers here, `gatekeeper-inferlab` and
//   `gatekeeper-inferlabops`, in place of the archived `gatekeeper-inferops`. Both read only
//   `INFERLAB_AUTH_ORIGIN`, `INFEROPS_COMPANY` and `BASE_URL`.
// - Both refuse `INFEROPS_COMPANY = "internal"` (config.ts: anything but a tenant id turns sign-in
//   off). A stage whose company is `internal` therefore plans and builds, but its deploy is refused
//   until it names the tenant id InferOps maps its origin to (see {@link stageDeployBlockers}).
// - The sign-in proxy (`inferops.authorizeOrigin`) and the InferLab edge secret are the clean line's
//   own (FAC-296 part 2, `@gadgets/gatekeeper-kit/inferlab-edge`), served and sent by both InferLab
//   gatekeepers. The archived optional resource switches have no reader here and aren't declared.
// - The spend guard (`agents`) is the clean line's daily limit, not the archived
//   `MODEL_ALLOWLIST`/`DAILY_AGENT_TURN_LIMIT`, which nothing here reads: see {@link StageDefinition}.
// - Both stages' backends were last deployed from the archived line, whose Durable Object history
//   diverges from this line's at v4, so each names that lineage (`backendLineage`, FAC-296 part 3,
//   do-lineage.ts) and its generated config continues it instead of starting this line's history.

import { ARCHIVED_MAIN_BACKEND_LINEAGE, type DeployedLineage } from "./do-lineage.ts";

/** How people sign in to a stage. */
export type StageAuthMode =
  /**
   * Cloudflare Access gates the hostname at the edge only; the Workshop itself signs people in with
   * InferLab (`AUTH_GATEKEEPERS=inferlab`, password login off). The backend gets no `CF_ACCESS_*`,
   * because with `CF_ACCESS_AUD` set it takes the Access email as the identity and refuses every
   * other login, which would make "Sign in with Google" (FAC-300) unreachable.
   */
  "inferlab";

/** One persistent stage. */
export interface StageDefinition {
  /** The stage's public hostname: the router's custom domain, and the instance's whole origin. */
  hostname: string;
  /** Prepended to every worker name (`<prefix><package>`). Immutable once deployed. */
  workerPrefix: string;
  /** Prepended to every KV namespace title and R2 bucket name. Immutable once deployed. */
  resourcePrefix: string;
  /** How people sign in; see {@link StageAuthMode}. */
  auth: { mode: StageAuthMode };
  /** The InferLab environment the InferLab gatekeepers connect people to. */
  inferops: {
    /**
     * InferLab central-auth (`/authorize`, `/auth/token`), a bare HTTPS origin. It is also every
     * subject's issuer (`AUTH_GATEKEEPER_ISSUERS`) and, on the clean line, the origin
     * `gatekeeper-inferlabops` calls the InferOps API at.
     */
    authOrigin: string;
    /**
     * The one company this deployment belongs to: its InferOps tenant id. InferOps decides it, from
     * its own `auth.sso.inferosCompanies` entry for this origin, and refuses a session in any other
     * company; both gatekeepers check it again (`INFEROPS_COMPANY`). `"internal"` (InferLab's own,
     * reserved tenants only) is what the archived stages used; the clean line's gatekeepers refuse
     * it, so a stage naming it can't be deployed (see {@link stageDeployBlockers}).
     */
    company: "internal" | string;
    /**
     * Optional, dev only: a second hostname of this stage, served by `gatekeeper-inferlab`, that
     * forwards InferLab's sign-in pages (`INFERLAB_AUTHORIZE_ORIGIN`). Set it when InferLab's edge
     * admits only allowlisted addresses, so a browser elsewhere can still sign in. It exposes the
     * persona picker, so the stage's Access application must cover it (the deploy checks), and
     * InferLab must list it in `auth.sso.proxyOrigins`. It resolves the same subject into the same
     * pipeline; an origin InferLab doesn't list is ignored there.
     */
    authorizeOrigin?: string;
  };
  /**
   * Optional spend guard on the platform's own models. `dailyTurnLimit` agent turns per workspace
   * owner per UTC day (`ENABLE_CLOUDFLARE_LIMITS=true` with `DAILY_LLM_CALL_LIMIT`: the overseer
   * checks it before every turn and refuses the turn once the day's are used). Which models are
   * offered comes from the optional `STAGE_ADMIN_CONFIG_SEED` input (the backend's
   * `ADMIN_CONFIG_SEED`, the Models tab). Neither is a dollar bound: that's the provider's spend
   * limit on the key the gateway stores.
   */
  agents?: { dailyTurnLimit: number };
  /**
   * The gatekeepers this stage deploys. A gatekeeper left out is neither deployed nor bound, so it
   * is absent from the Workshop rather than offered and broken: the third-party gatekeepers need an
   * OAuth app (`CLIENT_ID`/`CLIENT_SECRET`) that a stage does not configure.
   */
  gatekeepers: readonly string[];
  /** Refuse to deploy from a dirty or detached working tree. */
  requireCleanTree: boolean;
  /**
   * The Durable Object history the stage's deployed backend already has, when it came from another
   * line (do-lineage.ts). The generated backend config carries that history and its continuation
   * instead of this line's own; packages/workshop-backend/wrangler.jsonc is untouched. Absent for a
   * stage whose backend has only ever been deployed from this line.
   */
  backendLineage?: {
    lineage: DeployedLineage;
    /**
     * How we know the deployed backend's last applied tag is in `lineage.applied`, or null when
     * nobody has checked. A stage with an unverified lineage plans but doesn't deploy.
     */
    verified: string | null;
  };
}

/** The gatekeeper that signs people in with InferLab, and its vendor id. */
export const INFERLAB_GATEKEEPER = "gatekeeper-inferlab";
export const INFERLAB_LOGIN_VENDOR = "inferlab";
/** The gatekeeper that reaches InferOps data with the person's own InferLab session. */
export const INFERLABOPS_GATEKEEPER = "gatekeeper-inferlabops";

/**
 * The gatekeepers every stage runs today: InferLab sign-in and InferOps data, and the ones that need
 * no third-party OAuth app, as on the archived stages. `gatekeeper-mcp-portal` is left out because
 * it needs an admin-configured portal URL, and `gatekeeper-homeassistant` because nothing here uses
 * it; every other gatekeeper needs an OAuth app.
 */
export const STAGE_GATEKEEPERS = [
  INFERLAB_GATEKEEPER, INFERLABOPS_GATEKEEPER, "gatekeeper-context", "gatekeeper-scheduler",
  "gatekeeper-mcp",
] as const;

/** Every stage `pnpm stage:*` accepts, by name. Never change a prefix once a stage is deployed. */
export const STAGES = {
  dev: {
    hostname: "dev-os.factorylevel.dev",
    workerPrefix: "inferos-dev-",
    resourcePrefix: "inferos-dev-",
    auth: { mode: "inferlab" },
    // dev-os is one customer's instance (FAC-297): Brightwire Electrical's tenant, the id InferOps'
    // config/development.js auth.sso.inferosCompanies maps https://dev-os.factorylevel.dev to.
    inferops: {
      authOrigin: "https://auth.dev.inferlab.io",
      company: "9b7d4aaf-ba34-4f12-b281-9cbc8356b77e",
      authorizeOrigin: "https://auth.dev-os.factorylevel.dev",
    },
    gatekeepers: STAGE_GATEKEEPERS,
    requireCleanTree: false,
    agents: { dailyTurnLimit: 40 },
    backendLineage: {
      lineage: ARCHIVED_MAIN_BACKEND_LINEAGE,
      verified: "2026-11-23 ~11:15Z, the manager's deploy from d4a4d00e0: wrangler deploy of " +
        'inferos-dev-workshop-backend reported the published migration tag "v5"',
    },
  },
  prod: {
    hostname: "os.factorylevel.dev",
    workerPrefix: "inferos-prod-",
    resourcePrefix: "inferos-prod-",
    auth: { mode: "inferlab" },
    inferops: { authOrigin: "https://auth.inferlab.io", company: "internal" },
    gatekeepers: STAGE_GATEKEEPERS,
    requireCleanTree: true,
    // Assumed from the archived stage deploy, not checked: nobody has read inferos-prod-workshop-
    // backend's published tag. Any archived tag up to v5 would continue correctly, but until someone
    // reads it the deploy is refused (stageDeployBlockers), and prod may not apply the deletion
    // either (do-lineage.ts LINEAGE_DELETION_STAGES).
    backendLineage: { lineage: ARCHIVED_MAIN_BACKEND_LINEAGE, verified: null },
  },
} as const satisfies Record<string, StageDefinition>;

/** A stage name `pnpm stage:*` accepts. */
export type StageName = keyof typeof STAGES;

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PREFIX = /^[a-z][a-z0-9-]*-$/;

/** Whether `value` names a deployment's company: `"internal"`, or a lowercase tenant id. */
export function isDeploymentCompany(value: string): boolean {
  return value === "internal" || TENANT_ID.test(value);
}

/** Whether `value` is a bare `https://` origin: no path, query, fragment or credentials. */
export function isBareHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * The problems with one stage definition, or none. Checked before anything is generated, so a
 * malformed origin fails the run rather than a sign-in on the deployed instance.
 */
export function stageDefinitionProblems(stage: StageDefinition): string[] {
  const problems: string[] = [];
  if (!HOSTNAME.test(stage.hostname)) problems.push(`hostname "${stage.hostname}" is not a lowercase DNS name`);
  for (const [field, value] of [["workerPrefix", stage.workerPrefix], ["resourcePrefix", stage.resourcePrefix]]) {
    if (!PREFIX.test(value)) problems.push(`${field} "${value}" must be lowercase, start with a letter and end with "-"`);
  }
  if (!isBareHttpsOrigin(stage.inferops.authOrigin)) {
    problems.push(`inferops.authOrigin "${stage.inferops.authOrigin}" must be a bare https:// origin`);
  }
  if (!isDeploymentCompany(stage.inferops.company)) {
    problems.push(`inferops.company must be "internal" or a lowercase tenant id`);
  }
  const proxy = stage.inferops.authorizeOrigin;
  // Dev only, structurally: a production stage (one that deploys only from a clean tree) never
  // serves InferLab's sign-in pages from a hostname of its own.
  if (proxy !== undefined && stage.requireCleanTree) {
    problems.push("inferops.authorizeOrigin is for a dev stage only; a production stage can't have a sign-in proxy");
  }
  if (proxy !== undefined) {
    if (!isBareHttpsOrigin(proxy) || proxy === stage.inferops.authOrigin) {
      problems.push(`inferops.authorizeOrigin "${proxy}" must be a bare https:// origin other than authOrigin`);
    } else if (new URL(proxy).hostname === stage.hostname || !HOSTNAME.test(new URL(proxy).hostname)) {
      problems.push(`inferops.authorizeOrigin must name its own lowercase hostname, not the stage's`);
    }
  }
  if (stage.agents && !(Number.isInteger(stage.agents.dailyTurnLimit) && stage.agents.dailyTurnLimit > 0)) {
    problems.push("agents.dailyTurnLimit must be a positive whole number");
  }
  for (const required of [INFERLAB_GATEKEEPER, INFERLABOPS_GATEKEEPER]) {
    if (!stage.gatekeepers.includes(required)) problems.push(`gatekeepers must include ${required}`);
  }
  return problems;
}

/**
 * What stops a well-formed stage being deployed on the clean line, or nothing. Unlike
 * {@link stageDefinitionProblems} these don't stop a dry run: the plan is printed with them, so the
 * rehearsal says what the deploy would refuse.
 */
export function stageDeployBlockers(stage: StageDefinition): string[] {
  const blockers: string[] = [];
  if (stage.inferops.company === "internal") {
    blockers.push('inferops.company is "internal", which gatekeeper-inferlab and gatekeeper-inferlabops refuse ' +
      "(INFEROPS_COMPANY must be a tenant id there, or sign-in is off). Set it to the tenant id " +
      "InferOps' auth.sso.inferosCompanies maps this origin to, once InferOps maps it to one.");
  }
  if (stage.backendLineage && stage.backendLineage.verified === null) {
    blockers.push(`the backend's ${stage.backendLineage.lineage.name} Durable Object lineage is unverified: ` +
      "nobody has read the deployed workshop-backend's published migration tag. Read it (the tag a " +
      "deploy reports, or the worker's settings), then record how in backendLineage.verified.");
  }
  return blockers;
}

/** Resolve a stage by name, or say which exist. */
export function resolveStage(name: string): { name: StageName; stage: StageDefinition } {
  if (!Object.hasOwn(STAGES, name)) {
    throw new Error(`unknown stage "${name}"; expected one of: ${Object.keys(STAGES).join(", ")}`);
  }
  const stage: StageDefinition = STAGES[name as StageName];
  const problems = stageDefinitionProblems(stage);
  if (problems.length > 0) throw new Error(`stage "${name}" is invalid:\n  - ${problems.join("\n  - ")}`);
  return { name: name as StageName, stage };
}
