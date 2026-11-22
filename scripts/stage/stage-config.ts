// Generates the `wrangler.stage-<name>.jsonc` each deployable package is deployed from when
// `scripts/stage/stage.ts` deploys a persistent stage (see stages.ts). Everything here is pure:
// packages, account id, KV namespace ids and secret inputs are all passed in, so the tests can
// build every config without a network or a Cloudflare account.
//
// A stage is a real `wrangler deploy` of stage-prefixed workers, not a Worker Preview. A preview
// is a per-PR branch of a baseline worker, reachable only at a public workers.dev URL and swept
// when its PR closes; a stage is long-lived, served from a custom domain behind Cloudflare Access,
// and keeps its Durable Objects, which belong to the worker *name*. So this mirrors
// preview/staging-config.ts's topology, reusing its service-binding builders, `BASE_URL`s,
// `sharingDomain` and AI Gateway inputs, but resolves every worker and resource to a stable,
// prefixed name instead.
//
// Ported to the clean line from the archived main (FAC-296); see stages.ts for what changed.

import { createHash } from "node:crypto";
import {
  gatekeeperShortName, isGatekeeperPackage,
  type DeployablePackage, type ObservabilityConfig,
} from "../release/manifest-lib.ts";
import {
  R2_MAX_BUCKET_NAME_LENGTH, backendGatekeeperServices, resolveAiGateway, routerGatekeeperServices,
  type StagingConfig,
} from "../preview/staging-config.ts";
import {
  INFERLAB_GATEKEEPER, INFERLAB_LOGIN_VENDOR, INFERLABOPS_GATEKEEPER, type StageDefinition,
} from "./stages.ts";

type PackageConfig = Pick<DeployablePackage, "name" | "config">;

/** The config file name a stage's packages are deployed from. */
export function stageConfigFileName(stageName: string): string {
  return `wrangler.stage-${stageName}.jsonc`;
}

/** The worker a package is deployed as in a stage. */
export function stageWorkerName(stage: StageDefinition, pkgName: string): string {
  return `${stage.workerPrefix}${pkgName}`;
}

function kebab(binding: string): string {
  return binding.toLowerCase().replaceAll("_", "-");
}

/** The title of a package's KV namespace in a stage: one per package and binding. */
export function stageKvTitle(stage: StageDefinition, pkgName: string, binding: string): string {
  return `${stage.resourcePrefix}${pkgName}-${kebab(binding)}`;
}

/** The name of an R2 bucket in a stage: one per binding, shared across packages. */
export function stageBucketName(stage: StageDefinition, binding: string): string {
  return `${stage.resourcePrefix}${kebab(binding)}`;
}

/** Every R2 bucket a stage's packages bind. */
export function stageR2Buckets(stage: StageDefinition, packages: readonly PackageConfig[]): string[] {
  return [...new Set(stagePackages(stage, packages).flatMap((pkg) =>
    (pkg.config.r2_buckets ?? []).map(({ binding }) => stageBucketName(stage, binding))))];
}

/** One KV namespace a stage needs. */
export interface StageKvNamespace {
  pkgName: string;
  binding: string;
  title: string;
}

/** The packages a stage deploys: every non-gatekeeper package, and the stage's gatekeepers. */
export function stagePackages<T extends PackageConfig>(stage: StageDefinition, packages: readonly T[]): T[] {
  const names = new Set(packages.map((pkg) => pkg.name));
  const missing = stage.gatekeepers.filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`stage gatekeepers are not deployable packages: ${missing.join(", ")}`);
  return packages.filter((pkg) =>
    !isGatekeeperPackage(pkg.name) || stage.gatekeepers.includes(pkg.name));
}

/** Every KV namespace a stage's packages bind. */
export function stageKvNamespaces(stage: StageDefinition, packages: readonly PackageConfig[]): StageKvNamespace[] {
  return stagePackages(stage, packages).flatMap((pkg) =>
    (pkg.config.kv_namespaces ?? []).map(({ binding }) =>
      ({ pkgName: pkg.name, binding, title: stageKvTitle(stage, pkg.name, binding) })));
}

/**
 * Durable Object migrations that delete, rename or move a class: `wrangler rollback` never undoes
 * them, so the deploy refuses them unless asked.
 */
export function destructiveMigrations(packages: readonly PackageConfig[]): string[] {
  const found: string[] = [];
  for (const pkg of packages) {
    for (const migration of pkg.config.migrations ?? []) {
      for (const key of ["deleted_classes", "renamed_classes", "transferred_classes"] as const) {
        const value = (migration as Record<string, unknown>)[key];
        if (Array.isArray(value) && value.length > 0) found.push(`${pkg.name} migration ${migration.tag}: ${key}`);
      }
    }
  }
  return found;
}

// Persistent instances keep the committed observability settings, except that invocation logs are
// on: a stage is where acceptance runs, and they are the only record of a failed request.
function stageObservability(config: StagingConfig): ObservabilityConfig {
  return {
    ...config.observability,
    enabled: true,
    logs: { ...config.observability?.logs, invocation_logs: true },
  };
}

/**
 * The vars both InferLab gatekeepers read besides `BASE_URL` (their `config.ts` `readConfig`):
 * InferLab central-auth, which is also the API origin `gatekeeper-inferlabops` calls, and the one
 * company the deployment serves.
 */
export function inferLabGatekeeperVars(stage: StageDefinition): Record<string, string> {
  return {
    INFERLAB_AUTH_ORIGIN: stage.inferops.authOrigin,
    INFEROPS_COMPANY: stage.inferops.company,
  };
}

/** The one hostname a stage worker is reachable at, or null: only the router has one. */
export function stageWorkerHost(stage: StageDefinition, pkgName: string): string | null {
  return pkgName === "router" ? stage.hostname : null;
}

/** Every hostname a stage serves, each of which must be behind Cloudflare Access. */
export function stageHostnames(stage: StageDefinition): string[] {
  return [stage.hostname];
}

/** The backend's plain vars. Nothing here is secret: Wrangler prints every var's value. */
export function backendVars(stage: StageDefinition, origin: string): Record<string, string> {
  return {
    PUBLIC_BASE_URL: origin,
    // InferLab is the only way in (workshop-backend auth/config.ts): the sign-in gatekeeper, the
    // issuer its subjects carry, and password login off. Password login stays on if no sign-in
    // gatekeeper is allowlisted, so the three go together.
    AUTH_GATEKEEPERS: INFERLAB_LOGIN_VENDOR,
    AUTH_GATEKEEPER_ISSUERS: `${INFERLAB_LOGIN_VENDOR}=${stage.inferops.authOrigin}`,
    DISABLE_PASSWORD_AUTH: "true",
  };
}

// The InferLab gatekeepers' local-development settings must never reach a stage: there, every
// account is a person's own InferLab session. Any of these left in a package's committed vars fails
// the config build.
const FORBIDDEN_GATEKEEPER_VARS = [
  "INFEROPS_API_TOKEN", "INFEROPS_WORKSPACE_ID", "INFEROPS_WORKSPACE_SLUG", "MOCK_INFEROPS_SYNTHETIC_ISSUES",
];

/** Build every package's stage config. Pure; `kvIds` maps a KV title to its namespace id. */
export function buildStageConfigs({
  stage, packages, accountId, kvIds,
}: {
  stage: StageDefinition;
  packages: readonly PackageConfig[];
  accountId: string;
  kvIds: ReadonlyMap<string, string>;
}): Map<string, StagingConfig> {
  if (!accountId) throw new Error("buildStageConfigs needs an accountId");
  const origin = `https://${stage.hostname}`;
  const deployed = stagePackages(stage, packages);
  const gatekeepers = deployed.map((pkg) => pkg.name).filter(isGatekeeperPackage).toSorted();
  const workerName = (pkgName: string) => stageWorkerName(stage, pkgName);
  const configs = new Map<string, StagingConfig>();

  for (const pkg of deployed) {
    const config: StagingConfig = structuredClone(pkg.config);
    if (config.name !== pkg.name) {
      throw new Error(`${pkg.name}/wrangler.jsonc declares worker name "${config.name}"; the ` +
          `stage generator requires them to match`);
    }
    Object.assign(config, {
      name: workerName(pkg.name),
      account_id: accountId,
      // Only the router is reachable, and only at its custom domain behind Access: a workers.dev or
      // preview URL would be a way around Access.
      workers_dev: false,
      preview_urls: false,
      observability: stageObservability(config),
    });
    delete config.routes;
    delete config.previews;

    if (config.kv_namespaces) {
      config.kv_namespaces = config.kv_namespaces.map(({ binding }) => {
        const title = stageKvTitle(stage, pkg.name, binding);
        const id = kvIds.get(title);
        if (!id) throw new Error(`no KV namespace id for "${title}" (${pkg.name} ${binding})`);
        return { binding, id };
      });
    }
    if (config.r2_buckets) {
      config.r2_buckets = config.r2_buckets.map(({ binding }) => {
        const bucket_name = stageBucketName(stage, binding);
        if (bucket_name.length > R2_MAX_BUCKET_NAME_LENGTH) {
          throw new Error(`R2 bucket name "${bucket_name}" is longer than ${R2_MAX_BUCKET_NAME_LENGTH}`);
        }
        return { binding, bucket_name };
      });
    }

    if (isGatekeeperPackage(pkg.name)) {
      config.vars = {
        ...config.vars,
        BASE_URL: `${origin}/gatekeeper/${gatekeeperShortName(pkg.name)}`,
        ...(pkg.name === INFERLAB_GATEKEEPER || pkg.name === INFERLABOPS_GATEKEEPER
          ? inferLabGatekeeperVars(stage) : {}),
      };
      for (const name of FORBIDDEN_GATEKEEPER_VARS) {
        if (config.vars[name] !== undefined) throw new Error(`${pkg.name} must not carry ${name} in a stage`);
      }
    } else if (pkg.name === "workshop-backend") {
      // Injected rather than read from wrangler.jsonc, as manifest-lib.ts and the preview do.
      config.ai = { binding: "WORKERS_AI" };
      config.services = backendGatekeeperServices(gatekeepers, origin, workerName);
      config.vars = { ...config.vars, ...backendVars(stage, origin) };
    } else if (pkg.name === "router") {
      config.services = [
        { binding: "WORKSHOP_BACKEND", service: workerName("workshop-backend") },
        ...routerGatekeeperServices(gatekeepers, workerName),
      ];
      config.routes = [{ pattern: stage.hostname, custom_domain: true }];
    } else {
      throw new Error(`cannot build a stage config for package: ${pkg.name}`);
    }
    configs.set(pkg.name, config);
  }
  return configs;
}

/** The stage's admin emails (`STAGE_ADMINS`), at least one. */
export function resolveStageAdmins({ list = process.env.STAGE_ADMINS }: { list?: string } = {}): string[] {
  const admins = (list ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (admins.length === 0) {
    throw new Error("STAGE_ADMINS must list at least one admin email: a stage deployed without one " +
        "has no reachable /admin panel");
  }
  return admins;
}

/**
 * The backend's secrets: `ADMINS` and the AI Gateway names (preview/staging-config.ts
 * `resolveAiGateway`), never the Cloudflare Access pair (see stages.ts `StageAuthMode`). Uploaded
 * with the worker's version, never written into a config or printed.
 */
export function stageBackendSecrets({
  admins = resolveStageAdmins(),
  aiGateway = resolveAiGateway(),
}: { admins?: string[]; aiGateway?: Record<string, string> } = {}): Record<string, string> {
  return { ADMINS: JSON.stringify(admins), ...aiGateway };
}

/** One tier of a stage deploy: packages deployed together. */
export interface StageTier {
  label: string;
  packages: string[];
}

/**
 * The deploy order, as a preview's: gatekeepers (which bind nothing), the backend (which binds
 * them), then the router (which binds everything and owns the hostname).
 */
export function stageTiers(configs: ReadonlyMap<string, StagingConfig>): StageTier[] {
  const names = [...configs.keys()];
  return [
    { label: "gatekeepers (concurrently)", packages: names.filter(isGatekeeperPackage).toSorted() },
    { label: "backend", packages: names.filter((name) => name === "workshop-backend") },
    { label: "router", packages: names.filter((name) => name === "router") },
  ];
}

/** The plan a dry run prints: names only, never a secret value or a company's tenant id. */
export function formatStagePlan({ stageName, stage, configs, secretNames, kv, blockers = [] }: {
  stageName: string;
  stage: StageDefinition;
  configs: ReadonlyMap<string, StagingConfig>;
  secretNames: readonly string[];
  kv: readonly StageKvNamespace[];
  blockers?: readonly string[];
}): string {
  // The company is named only when it's `internal`: a company's tenant id goes to
  // `INFEROPS_COMPANY` alone, never into a plan meant to be pasted into a PR or a log.
  const company = stage.inferops.company === "internal" ? "internal" : "tenant id set";
  const lines = [
    `stage "${stageName}" -> https://${stage.hostname} (InferLab ${stage.inferops.authOrigin}, company ${company})`,
  ];
  for (const tier of stageTiers(configs)) {
    lines.push(`  ${tier.label}:`);
    for (const pkgName of tier.packages) {
      const config = configs.get(pkgName) as StagingConfig;
      const vars = Object.keys(config.vars ?? {}).toSorted().join(", ");
      const host = stageWorkerHost(stage, pkgName);
      const services = (config.services ?? []).map((s) => (s as { service: string }).service);
      const extra = (host ? ` at ${host} (custom domain)` : "") +
        (pkgName === "workshop-backend" ? `, secrets: ${secretNames.join(", ")}` : "") +
        (services.length > 0 ? `, binds: ${services.join(", ")}` : "");
      lines.push(`    ${config.name}${extra}${vars ? ` [vars: ${vars}]` : ""}`);
    }
  }
  lines.push("  KV namespaces:", ...kv.map((ns) => `    ${ns.title} (${ns.pkgName} ${ns.binding})`));
  const buckets = [...new Set([...configs.values()].flatMap((config) =>
    (config.r2_buckets ?? []).map((bucket) => (bucket as { bucket_name?: string }).bucket_name)))];
  lines.push("  R2 buckets:", ...buckets.map((name) => `    ${name}`));
  if (blockers.length > 0) {
    lines.push("  REFUSED: the deploy would stop here:", ...blockers.map((b) => `    - ${b}`));
  }
  return lines.join("\n");
}

/** A short digest of every config, for the deploy message and record. */
export function stageConfigDigest(configs: ReadonlyMap<string, StagingConfig>): string {
  const hash = createHash("sha256");
  for (const [name, config] of [...configs].toSorted(([a], [b]) => a.localeCompare(b))) {
    hash.update(name).update(JSON.stringify(config));
  }
  return hash.digest("hex").slice(0, 12);
}
