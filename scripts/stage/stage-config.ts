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
  type DeployablePackage, type DurableObjectMigration, type ObservabilityConfig,
} from "../release/manifest-lib.ts";
import {
  R2_MAX_BUCKET_NAME_LENGTH, backendGatekeeperServices, resolveAdminConfigSeed, resolveAiGateway,
  routerGatekeeperServices, type StagingConfig,
} from "../preview/staging-config.ts";
import {
  continueLineage, destructiveSteps, isDeclaredDeletion, type DestructiveStep,
} from "./do-lineage.ts";
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
 * The Durable Object history a package is deployed with in a stage: its own, except the backend of
 * a stage that names a deployed lineage, which continues that lineage (do-lineage.ts). Throws when
 * the lineage no longer matches the package's own history.
 */
export function stageMigrations(stage: StageDefinition, pkg: PackageConfig): DurableObjectMigration[] {
  const own = pkg.config.migrations ?? [];
  return pkg.name === "workshop-backend" && stage.backendLineage
    ? continueLineage(own, stage.backendLineage.lineage) : structuredClone(own);
}

/** A stage's destructive Durable Object migrations, split into the declared one and the rest. */
export interface StageDestructiveMigrations {
  /** The lineage's declared deletion, on a stage allowed to apply it (do-lineage.ts). */
  declared: DestructiveStep[];
  /** Every other delete, rename or transfer: refused unless `--allow-destructive-migrations`. */
  refused: DestructiveStep[];
}

/** One destructive step, as the plan and the refusal print it. */
export function describeStep(step: DestructiveStep): string {
  return `${step.pkgName} migration ${step.tag}: ${step.operation} ${step.classes.join(", ")}`;
}

/**
 * Durable Object migrations that delete, rename or move a class, in the histories the stage would
 * deploy: `wrangler rollback` never undoes them. Only the declared lineage deletion of a stage
 * allowed it by name is `declared`; anything else is `refused`.
 */
export function destructiveMigrations(stageName: string, stage: StageDefinition,
    packages: readonly PackageConfig[]): StageDestructiveMigrations {
  const result: StageDestructiveMigrations = { declared: [], refused: [] };
  for (const pkg of packages) {
    for (const step of destructiveSteps(pkg.name, stageMigrations(stage, pkg))) {
      (isDeclaredDeletion(stageName, stage.backendLineage?.lineage, step) ? result.declared : result.refused).push(step);
    }
  }
  return result;
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
    // The dev sign-in proxy (FAC-296 part 2): gatekeeper-inferlab serves it, and both send the
    // browser there. Not a secret: it's a hostname of the stage.
    ...(stage.inferops.authorizeOrigin ? { INFERLAB_AUTHORIZE_ORIGIN: stage.inferops.authorizeOrigin } : {}),
  };
}

/**
 * The one hostname a stage worker is reachable at, or null. The router owns the stage's hostname;
 * on a stage with a sign-in proxy, gatekeeper-inferlab owns the proxy's. Nothing else has one.
 */
export function stageWorkerHost(stage: StageDefinition, pkgName: string): string | null {
  if (pkgName === "router") return stage.hostname;
  if (pkgName === INFERLAB_GATEKEEPER && stage.inferops.authorizeOrigin) {
    return new URL(stage.inferops.authorizeOrigin).hostname;
  }
  return null;
}

/** Every hostname a stage serves, each of which must be behind Cloudflare Access. */
export function stageHostnames(stage: StageDefinition): string[] {
  return [stage.hostname,
    ...(stage.inferops.authorizeOrigin ? [new URL(stage.inferops.authorizeOrigin).hostname] : [])];
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
    // The spend guard (FAC-296 part 2): agent turns per workspace owner per UTC day, refused once
    // used (workshop-backend ai-gateway-billing/limits, checked before every turn).
    ...(stage.agents ? {
      ENABLE_CLOUDFLARE_LIMITS: "true",
      DAILY_LLM_CALL_LIMIT: String(stage.agents.dailyTurnLimit),
    } : {}),
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
      // Only the router (and, on dev, gatekeeper-inferlab's sign-in proxy) is reachable, and only at
      // its custom domain behind Access: a workers.dev or preview URL would be a way around Access.
      workers_dev: false,
      preview_urls: false,
      observability: stageObservability(config),
    });
    delete config.routes;
    delete config.previews;
    if (config.migrations) config.migrations = stageMigrations(stage, pkg);

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
      const host = stageWorkerHost(stage, pkg.name);
      if (host) config.routes = [{ pattern: host, custom_domain: true }];
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
 * The backend's secrets: `ADMINS`, the AI Gateway names (preview/staging-config.ts
 * `resolveAiGateway`) and, when `STAGE_ADMIN_CONFIG_SEED` is set, `ADMIN_CONFIG_SEED` (the Models
 * tab the stage starts with: which models it offers). Never the Cloudflare Access pair (see
 * stages.ts `StageAuthMode`). Uploaded with the worker's version, never written into a config or
 * printed.
 */
export function stageBackendSecrets({
  admins = resolveStageAdmins(),
  aiGateway = resolveAiGateway(),
  // `?? ""`: an unset stage seed must not fall back to the preview's PREVIEW_ADMIN_CONFIG_SEED default.
  adminConfigSeed = resolveAdminConfigSeed({ seed: process.env.STAGE_ADMIN_CONFIG_SEED ?? "" }),
}: {
  admins?: string[]; aiGateway?: Record<string, string>; adminConfigSeed?: Record<string, string>;
} = {}): Record<string, string> {
  return { ADMINS: JSON.stringify(admins), ...aiGateway, ...adminConfigSeed };
}

/** The edge secret's shape: what InferLab's WAF rule accepts (inferops `waf:inferosEdgeSecret`). */
const EDGE_SECRET = /^[A-Za-z0-9_-]{32,}$/;

/**
 * The edge secret input for each stage: its own name, so one stage's value (a dev secret left in the
 * shell) never deploys to another. Listed out, not built from the name, so env-passthrough.test.ts
 * (which discovers env reads textually) sees each one.
 */
export function stageEdgeSecretInput(stageName: string): string | undefined {
  const inputs: Record<string, string | undefined> = {
    dev: process.env.INFEROPS_EDGE_SECRET_DEV,
    prod: process.env.INFEROPS_EDGE_SECRET_PROD,
  };
  return inputs[stageName];
}

/** The input name {@link stageEdgeSecretInput} reads for a stage. */
export const stageEdgeSecretName = (stageName: string): string => `INFEROPS_EDGE_SECRET_${stageName.toUpperCase()}`;

/**
 * Each InferLab gatekeeper's secrets: `INFEROPS_EDGE_SECRET` when the stage has one, the shared
 * value InferLab's edge lets through (FAC-296 part 2), from the stage's own input
 * (`INFEROPS_EDGE_SECRET_<STAGE>`). Both gatekeepers send it, to the InferLab origin only. A value
 * that isn't the WAF rule's shape stops the run rather than deploying a stage InferLab will refuse,
 * and so does a bare `INFEROPS_EDGE_SECRET` in the shell, which names no stage. No value is shown.
 */
export function stageGatekeeperSecrets({
  stageName,
  edgeSecret = stageEdgeSecretInput(stageName),
  bareEdgeSecret = process.env.INFEROPS_EDGE_SECRET,
}: { stageName: string; edgeSecret?: string; bareEdgeSecret?: string }): Record<string, Record<string, string>> {
  if (bareEdgeSecret?.trim()) {
    throw new Error(`INFEROPS_EDGE_SECRET names no stage; set ${stageEdgeSecretName(stageName)} for ` +
        `this stage instead, and unset INFEROPS_EDGE_SECRET (its value is not shown)`);
  }
  const value = edgeSecret?.trim();
  if (!value) return {};
  if (!EDGE_SECRET.test(value)) {
    throw new Error(`${stageEdgeSecretName(stageName)} must be at least 32 characters of [A-Za-z0-9_-], ` +
        "the same value as InferLab's waf:inferosEdgeSecret (its value is not shown)");
  }
  return Object.fromEntries([INFERLAB_GATEKEEPER, INFERLABOPS_GATEKEEPER]
    .map((pkg) => [pkg, { INFEROPS_EDGE_SECRET: value }]));
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

/**
 * Each worker's Durable Object migrations, as the plan prints them: the tags, and for a backend that
 * continues a deployed lineage, which tags are already applied and what the continuation does.
 */
export function formatMigrationPlan(stage: StageDefinition, configs: ReadonlyMap<string, StagingConfig>,
    declared: readonly DestructiveStep[] = []): string[] {
  const lines = ["  Durable Object migrations:"];
  for (const [pkgName, config] of [...configs].toSorted(([a], [b]) => a.localeCompare(b))) {
    const migrations = config.migrations ?? [];
    if (migrations.length === 0) continue;
    const lineage = pkgName === "workshop-backend" ? stage.backendLineage : undefined;
    if (!lineage) {
      lines.push(`    ${config.name}: ${migrations.map((m) => m.tag).join(", ")} (this line's own history)`);
      continue;
    }
    const { applied, continuation } = lineage.lineage;
    const added = (continuation.new_sqlite_classes ?? []).join(", ");
    const deleted = ((continuation.deleted_classes as string[] | undefined) ?? []).join(", ");
    lines.push(`    ${config.name}: ${migrations.map((m) => m.tag).join(", ")}, continuing the ` +
        `${lineage.lineage.name} lineage (${lineage.verified ? "verified" : "UNVERIFIED"})`,
      `      already applied there: ${applied.map((m) => `${m.tag} ${(m.new_sqlite_classes ?? []).join(" + ")}`).join("; ")}`,
      `      ${continuation.tag} adds ${added || "nothing"}` + (deleted ? `; DELETES ${deleted} and their storage` +
        (declared.some((step) => step.tag === continuation.tag) ? " (declared for this stage)" : "") : ""));
  }
  return lines;
}

/** The plan a dry run prints: names only, never a secret value or a company's tenant id. */
export function formatStagePlan({
  stageName, stage, configs, secretNames, gatekeeperSecretNames = {}, kv, blockers = [], declared = [],
}: {
  stageName: string;
  stage: StageDefinition;
  configs: ReadonlyMap<string, StagingConfig>;
  secretNames: readonly string[];
  gatekeeperSecretNames?: Readonly<Record<string, readonly string[]>>;
  kv: readonly StageKvNamespace[];
  blockers?: readonly string[];
  /** The declared lineage deletion this stage may apply (see {@link destructiveMigrations}). */
  declared?: readonly DestructiveStep[];
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
        (pkgName === "workshop-backend" ? `, secrets: ${secretNames.join(", ")}` :
          (gatekeeperSecretNames[pkgName] ?? []).length > 0
            ? `, secrets: ${(gatekeeperSecretNames[pkgName] ?? []).join(", ")}` : "") +
        (services.length > 0 ? `, binds: ${services.join(", ")}` : "");
      lines.push(`    ${config.name}${extra}${vars ? ` [vars: ${vars}]` : ""}`);
    }
  }
  lines.push("  KV namespaces:", ...kv.map((ns) => `    ${ns.title} (${ns.pkgName} ${ns.binding})`));
  const buckets = [...new Set([...configs.values()].flatMap((config) =>
    (config.r2_buckets ?? []).map((bucket) => (bucket as { bucket_name?: string }).bucket_name)))];
  lines.push("  R2 buckets:", ...buckets.map((name) => `    ${name}`));
  lines.push(...formatMigrationPlan(stage, configs, declared));
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
