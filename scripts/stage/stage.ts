#!/usr/bin/env node

// Deploys or inspects a persistent stage (stages.ts) on the account named by CLOUDFLARE_ACCOUNT_ID,
// using the workspace's pinned Wrangler and its login (`wrangler login`).
//
//   node scripts/stage/stage.ts config <stage>     resolve KV ids (read-only) and write the configs
//   node scripts/stage/stage.ts deploy <stage>     build, provision missing KV, deploy every tier
//   ... --dry-run                                  print the plan, touch no network, write nothing
//
// Deployment runs in three tiers, as a preview's does (preview/preview.ts): the stage's gatekeepers
// concurrently, then the backend that binds them, then the router that binds everything and owns
// the custom domain. A stage is a plain `wrangler deploy` of prefixed workers rather than a Worker
// Preview, so it needs neither the preview's draft Wrangler build nor its preview-id patching: a
// service binding names a worker, and each tier only has to exist before the next binds it. Each
// worker's version carries its secrets (`--secrets-file`), so no version ever runs without them;
// secret values never reach a config, argv or the log.
//
// Inputs: the shell first, then a gitignored `.stage-<stage>.vars` at the repository root.
//   STAGE_ADMINS                          required, comma-separated admin emails
//   CLOUDFLARE_ACCOUNT_ID                 required
//   CF_AI_GATEWAY*                        optional, see preview/staging-config.ts resolveAiGateway
//   STAGE_ADMIN_CONFIG_SEED               optional, the backend's ADMIN_CONFIG_SEED (the Models tab)
//   INFEROPS_EDGE_SECRET_<STAGE>          optional, both InferLab gatekeepers' InferLab edge header,
//                                         per stage (INFEROPS_EDGE_SECRET_DEV, _PROD)
//
// Ported to the clean line from the archived main (FAC-296). Not ported, because the clean line has
// none of what they check or the deploy doesn't need them: `stage:delete`, the automated smoke
// through an Access service token, the InferOps pin and board-schema gate, a company wrapper's
// deploy (`inferos:deploy`) and company storage. The Access redirect check after a deploy is kept,
// and the deploy ends by printing the smoke a person runs ({@link stageSmokeSteps}).

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { resolveBinEntry } from "../bin-entry.ts";
import { mapConcurrent } from "../map-concurrent.ts";
import { readDeployablePackages, type DeployablePackage } from "../release/manifest-lib.ts";
import { PACKAGES_DIR, ROOT, type StagingConfig } from "../preview/staging-config.ts";
import {
  buildStageConfigs, describeStep, destructiveMigrations, formatStagePlan, stageBackendSecrets,
  stageConfigDigest, stageConfigFileName, stageGatekeeperSecrets, stageHostnames, stageKvNamespaces,
  stagePackages, stageTiers, stageWorkerHost, type StageDestructiveMigrations,
} from "./stage-config.ts";
import {
  deployTargetProblem, parseDeployTargets, parseKvNamespaceList, retryWhileDnsPending,
} from "./stage-resources.ts";
import { resolveStage, stageDeployBlockers, type StageDefinition } from "./stages.ts";

type Command = "config" | "deploy";

/** The parsed command line. */
export interface StageArgs {
  command: Command;
  stage: string;
  dryRun: boolean;
  allowDirty: boolean;
  allowDestructiveMigrations: boolean;
}

const USAGE = "Usage: stage.ts <config|deploy> <stage> [--dry-run] [--allow-dirty] " +
  "[--allow-destructive-migrations]";
const GATEKEEPER_CONCURRENCY = 8;

/** Parse argv (without node and the script). Throws the usage on anything unexpected. */
export function parseStageArgs(argv: readonly string[]): StageArgs {
  const [command, stage, ...rest] = argv;
  if (command !== "config" && command !== "deploy") throw new Error(USAGE);
  if (!stage || stage.startsWith("--")) throw new Error(`name a stage\n${USAGE}`);
  const args: StageArgs = {
    command, stage, dryRun: false, allowDirty: false, allowDestructiveMigrations: false,
  };
  for (const arg of rest) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--allow-dirty") args.allowDirty = true;
    else if (arg === "--allow-destructive-migrations") args.allowDestructiveMigrations = true;
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  return args;
}

/** Load `.stage-<stage>.vars` under the shell: a name the shell sets keeps the shell's value. */
function loadStageVars(stageName: string): void {
  const path = join(ROOT, `.stage-${stageName}.vars`);
  if (!existsSync(path)) return;
  const values = parseEnv(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wranglerEntry(): string {
  const entry = resolveBinEntry(join(ROOT, "packages", "router"), "wrangler");
  if (!entry) throw new Error("wrangler is not installed; run pnpm install");
  return entry;
}

/** What one Wrangler run returned. */
export interface WranglerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runWrangler(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<WranglerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerEntry(), ...args], {
      cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
    child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function runInherited(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  console.log(`running: ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() :
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`)));
  });
}

async function listKvNamespaces(): Promise<Map<string, string>> {
  const result = await runWrangler(ROOT, ["kv", "namespace", "list"]);
  if (result.status !== 0) throw new Error(`wrangler kv namespace list failed:\n${result.stderr}`);
  return parseKvNamespaceList(result.stdout);
}

async function ensureKvNamespaces(titles: readonly string[]): Promise<Map<string, string>> {
  const existing = await listKvNamespaces();
  const missing = titles.filter((title) => !existing.has(title));
  if (missing.length === 0) return existing;
  // From an empty directory, so no Wrangler config can prefix the title.
  const scratch = mkdtempSync(join(tmpdir(), "stage-kv-"));
  try {
    for (const title of missing) {
      console.log(`creating KV namespace ${title}`);
      const result = await runWrangler(scratch, ["kv", "namespace", "create", title]);
      if (result.status !== 0) throw new Error(`wrangler kv namespace create ${title} failed:\n${result.stderr}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const after = await listKvNamespaces();
  const stillMissing = missing.filter((title) => !after.has(title));
  if (stillMissing.length > 0) throw new Error(`created but cannot find KV namespaces: ${stillMissing.join(", ")}`);
  return after;
}

function workingTreeState(): { sha: string; dirty: boolean } {
  const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
  return { sha, dirty };
}

/** Everything a stage command resolves before it touches the network. */
export interface Prepared {
  stageName: string;
  stage: StageDefinition;
  accountId: string;
  packages: DeployablePackage[];
  secrets: Record<string, string>;
  /** Each InferLab gatekeeper's secrets (the edge secret), by package. */
  gatekeeperSecrets: Record<string, Record<string, string>>;
  /** The destructive Durable Object migrations the stage would deploy (stage-config.ts). */
  destructive: StageDestructiveMigrations;
  /** `--allow-destructive-migrations`: deploy the refused ones too. */
  allowDestructiveMigrations: boolean;
}

/**
 * Why the destructive migrations stop this run, or nothing. The lineage deletion a stage declares
 * by name (do-lineage.ts) never does; any other delete, rename or transfer does unless
 * `--allow-destructive-migrations`.
 */
export function destructiveMigrationBlockers(prepared: Pick<Prepared, "destructive" | "allowDestructiveMigrations">): string[] {
  const { refused } = prepared.destructive;
  if (refused.length === 0 || prepared.allowDestructiveMigrations) return [];
  return ["Durable Object migrations that destroy or move state, which wrangler rollback never undoes: " +
    `${refused.map(describeStep).join("; ")}. Pass --allow-destructive-migrations to deploy them.`];
}

/**
 * Resolve the stage, its inputs and its packages. Reads the environment and the files in this
 * checkout only. The secrets are resolved even for a dry run, so a missing admin list is reported
 * by the rehearsal rather than by the deploy it was meant to rehearse.
 */
export function prepare(args: Pick<StageArgs, "stage" | "allowDestructiveMigrations">,
    packages: DeployablePackage[] = readDeployablePackages(PACKAGES_DIR)): Prepared {
  const { name: stageName, stage } = resolveStage(args.stage);
  loadStageVars(stageName);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID must be set to the account the stage deploys to");
  const deployed = stagePackages(stage, packages);
  return {
    stageName, stage, accountId, packages: deployed, secrets: stageBackendSecrets(),
    gatekeeperSecrets: stageGatekeeperSecrets({ stageName }),
    // Also checks a declared lineage against the backend's own history, so a mismatch stops even a
    // dry run.
    destructive: destructiveMigrations(stageName, stage, deployed),
    allowDestructiveMigrations: args.allowDestructiveMigrations,
  };
}

/** Everything that stops a deploy of this stage: the stage's own blockers and its migrations'. */
export function deployBlockers(prepared: Prepared): string[] {
  return [...stageDeployBlockers(prepared.stage), ...destructiveMigrationBlockers(prepared)];
}

/** The dry-run plan: built with placeholder KV ids, so it needs no network. */
export function dryRunPlan(prepared: Prepared): string {
  const { stageName, stage, accountId, packages, secrets } = prepared;
  const kv = stageKvNamespaces(stage, packages);
  const placeholderIds = new Map(kv.map((ns) => [ns.title, "<resolved at deploy>"]));
  const configs = buildStageConfigs({ stage, packages, accountId, kvIds: placeholderIds });
  return `dry-run plan (no network):\n${formatStagePlan({
    stageName, stage, configs, secretNames: Object.keys(secrets), kv, blockers: deployBlockers(prepared),
    declared: prepared.destructive.declared,
    gatekeeperSecretNames: Object.fromEntries(Object.entries(prepared.gatekeeperSecrets)
      .map(([pkg, values]) => [pkg, Object.keys(values)])),
  })}`;
}

function writeConfigs(prepared: Prepared, configs: ReadonlyMap<string, StagingConfig>): void {
  for (const pkg of prepared.packages) {
    const config = configs.get(pkg.name);
    if (!config) throw new Error(`no stage config was generated for ${pkg.name}`);
    writeFileSync(join(pkg.dir, stageConfigFileName(prepared.stageName)), JSON.stringify(config, null, 2) + "\n");
  }
  console.log(`wrote ${stageConfigFileName(prepared.stageName)} for ${prepared.packages.length} package(s)`);
}

async function deployWorker(
  prepared: Prepared, pkg: DeployablePackage, config: StagingConfig, message: string, scratch: string,
): Promise<void> {
  const outputFile = join(scratch, `${pkg.name}.output.ndjson`);
  const args = ["deploy", "-c", stageConfigFileName(prepared.stageName), "--message", message];
  const secrets = pkg.name === "workshop-backend" ? prepared.secrets : prepared.gatekeeperSecrets[pkg.name];
  if (secrets && Object.keys(secrets).length > 0) {
    const secretsFile = join(scratch, `${pkg.name}.secrets.json`);
    writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
    args.push("--secrets-file", secretsFile);
  }
  await deployRetryingFirstDeploy(config.name as string, async () => {
    console.log(`deploying ${config.name}`);
    rmSync(outputFile, { force: true });
    const result = await runWrangler(pkg.dir, args, { WRANGLER_OUTPUT_FILE_PATH: outputFile });
    if (result.stdout) process.stdout.write(`[${config.name}]\n${result.stdout}`);
    if (result.stderr) process.stderr.write(`[${config.name}]\n${result.stderr}`);
    return result;
  });
  const targets = parseDeployTargets(existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "");
  if (targets === null) throw new Error(`wrangler reported no deployment for ${config.name}`);
  const problem = deployTargetProblem(config.name as string, targets, stageWorkerHost(prepared.stage, pkg.name));
  if (problem) throw new Error(problem);
}

/** How many times a worker's first deploy is tried when it races its own creation, and the waits between. */
export const FIRST_DEPLOY_ATTEMPTS = 3;
const FIRST_DEPLOY_WAITS_MS = [5_000, 15_000];

/**
 * Whether a failed `wrangler deploy` is the first-deploy race: the upload created the worker, and
 * the next call (the version's secrets, with `--secrets-file`) was answered 10007, "This Worker does
 * not exist on your account". Seen on dev-os on 2026-11-23 for the two gatekeepers that run created;
 * a plain retry deployed both. A worker that existed before the run is never answered 10007, and an
 * output without "Uploaded" didn't create anything, so neither is retried.
 */
export function isFirstDeployRace(result: Pick<WranglerResult, "status" | "stdout" | "stderr">): boolean {
  if (result.status === 0) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  return /^\s*Uploaded\s/m.test(output) &&
    /This Worker does not exist on your account|code"?:\s*10007\b|\[code: 10007\]/i.test(output);
}

/**
 * Run one worker's deploy, retrying it (bounded, {@link FIRST_DEPLOY_ATTEMPTS}) only when it fails
 * with the first-deploy race. Any other failure, or the race on the last attempt, throws. A retry
 * uploads a new version with the same config and secrets: the worker exists by then.
 */
export async function deployRetryingFirstDeploy(
  workerName: string,
  attempt: () => Promise<WranglerResult>,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<WranglerResult> {
  for (let n = 1; ; n++) {
    const result = await attempt();
    if (result.status === 0) return result;
    if (!isFirstDeployRace(result)) {
      throw new Error(`wrangler deploy failed for ${workerName} with exit code ${result.status}`);
    }
    if (n >= FIRST_DEPLOY_ATTEMPTS) {
      throw new Error(`wrangler deploy failed for ${workerName}: still "This Worker does not exist" (10007) ` +
          `after ${n} attempts; the worker was uploaded, so check it in the dashboard and re-run the deploy`);
    }
    const wait = FIRST_DEPLOY_WAITS_MS[n - 1] ?? FIRST_DEPLOY_WAITS_MS.at(-1) ?? 0;
    console.log(`${workerName} was just created and isn't visible yet (10007); retrying in ${wait / 1000}s ` +
        `(attempt ${n + 1} of ${FIRST_DEPLOY_ATTEMPTS})`);
    await sleep(wait);
  }
}

/** Whether a response is Cloudflare Access's redirect to its login. */
export function isAccessRedirect(response: { status: number; location: string | null }): boolean {
  if (response.status < 300 || response.status >= 400 || !response.location) return false;
  try {
    return new URL(response.location).hostname.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
}

async function assertBehindAccess(stage: StageDefinition): Promise<void> {
  for (const hostname of stageHostnames(stage)) {
    const response = await retryWhileDnsPending(async () => {
      const res = await fetch(`https://${hostname}/`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
      return { status: res.status, location: res.headers.get("location") };
    });
    if (!isAccessRedirect(response)) {
      throw new Error(`https://${hostname}/ answered ${response.status} without credentials: the ` +
          "stage is deployed but NOT behind Cloudflare Access. Add the hostname to the Access " +
          "application now (docs/wiki/stage-deploy.md) before anyone else finds the URL.");
    }
    console.log(`https://${hostname}/ redirects to Cloudflare Access without credentials`);
  }
}

/**
 * The smoke a person runs after a deploy (FAC-296 part 2), printed as the deploy's last lines: the
 * sign-in only a real browser and a real seat can prove.
 */
export function stageSmokeSteps(stage: StageDefinition): string[] {
  return [
    `Open https://${stage.hostname} and pass Cloudflare Access.`,
    `Choose "Use a different Google account" and sign in as a seat of the stage's company` +
      (stage.inferops.authorizeOrigin
        ? ` (the sign-in page is served from ${new URL(stage.inferops.authorizeOrigin).hostname}).`
        : "."),
    // The clean line renders no InferOps board inside InferOS; a company's Project reaches it only
    // through the InferLab operations Gatekeeper, read with the person's own InferOps access.
    "On Gatekeepers, connect InferLab operations, then in a chat set up the InferOps Project connection the agent asks for with the company's address (inferops://<tenant>.<workspace>/project/project/<id>): the agent names that Project.",
    "Open a chat: the model picker shows an agent, and one message gets an answer.",
  ];
}

async function deploy(args: StageArgs): Promise<void> {
  const prepared = prepare(args);
  if (args.dryRun) {
    console.log(dryRunPlan(prepared));
    return;
  }
  const { stageName, stage, accountId, packages } = prepared;
  const blockers = deployBlockers(prepared);
  if (blockers.length > 0) {
    throw new Error(`stage "${stageName}" can't be deployed yet:\n  - ${blockers.join("\n  - ")}`);
  }
  for (const step of prepared.destructive.declared) {
    console.log(`this deploy applies the declared lineage deletion (do-lineage.ts): ${describeStep(step)}`);
  }
  const tree = workingTreeState();
  if (tree.dirty && (stage.requireCleanTree || !args.allowDirty)) {
    throw new Error(stage.requireCleanTree
      ? `stage "${stageName}" deploys only from a clean working tree; commit or stash first`
      : "the working tree is dirty; commit first, or pass --allow-dirty to deploy it anyway");
  }

  const kv = stageKvNamespaces(stage, packages);
  const [kvIds] = await Promise.all([
    ensureKvNamespaces(kv.map((ns) => ns.title)),
    // The frontend in non-Access mode: Access gates the edge, InferLab signs people in.
    runInherited("pnpm", ["run", "build"], { VITE_CF_ACCESS_MODE: "false" }),
  ]);
  const configs = buildStageConfigs({ stage, packages, accountId, kvIds });
  writeConfigs(prepared, configs);
  const message = `stage ${stageName} @ ${tree.sha}${tree.dirty ? "-dirty" : ""} (${stageConfigDigest(configs)})`;

  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const scratch = mkdtempSync(join(tmpdir(), "stage-deploy-"));
  try {
    for (const tier of stageTiers(configs)) {
      console.log(`\n== ${tier.label}`);
      await mapConcurrent(tier.packages, GATEKEEPER_CONCURRENCY, (name) =>
        deployWorker(prepared, byName.get(name) as DeployablePackage, configs.get(name) as StagingConfig, message, scratch));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`\nstage "${stageName}" is deployed at https://${stage.hostname}`);
  await assertBehindAccess(stage);
  console.log(JSON.stringify({ deployRecord: {
    inferosSha: tree.sha,
    configDigest: stageConfigDigest(configs),
    smoke: { automated: false, reason: "run by a person: the steps below (docs/stage-deploy.md)" },
  } }, null, 2));
  console.log(`\nNow run the smoke, by hand:\n${stageSmokeSteps(stage).map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`);
}

async function configure(args: StageArgs): Promise<void> {
  const prepared = prepare(args);
  if (args.dryRun) {
    console.log(dryRunPlan(prepared));
    return;
  }
  const { stage, accountId, packages } = prepared;
  const refused = destructiveMigrationBlockers(prepared);
  if (refused.length > 0) throw new Error(refused.join("\n"));
  const kv = stageKvNamespaces(stage, packages);
  const whoami = await runWrangler(ROOT, ["whoami"]);
  if (whoami.status !== 0) throw new Error(`wrangler whoami failed; run pnpm exec wrangler login:\n${whoami.stderr}`);
  if (!whoami.stdout.includes(accountId)) {
    throw new Error(`the Wrangler login cannot see account ${accountId}; check CLOUDFLARE_ACCOUNT_ID or log in as its member`);
  }
  console.log(`Wrangler login reaches account ${accountId}`);
  const existing = await listKvNamespaces();
  for (const ns of kv) console.log(`  KV ${ns.title}: ${existing.has(ns.title) ? "present" : "missing (stage:deploy creates it)"}`);
  if (kv.some((ns) => !existing.has(ns.title))) return;
  writeConfigs(prepared, buildStageConfigs({ stage, packages, accountId, kvIds: existing }));
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseStageArgs(argv);
  if (args.command === "deploy") await deploy(args);
  else await configure(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(describe(error));
    process.exit(1);
  });
}
