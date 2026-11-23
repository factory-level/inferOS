// FAC-296 part 3: a stage's backend continues the Durable Object history its deployed worker really
// has (dev-os: the archived main's v0..v5), then v6; previews and fresh deployments keep this line's
// own. The one destructive step allowed is the declared deletion, on dev, by name. And a worker's
// first deploy that races its own creation (10007) is retried, bounded.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readDeployablePackages } from "../release/manifest-lib.ts";
import { PACKAGES_DIR, buildPreviewConfigs } from "../preview/staging-config.ts";
import {
  ARCHIVED_MAIN_BACKEND_LINEAGE, ARCHIVED_MAIN_DELETED_CLASSES, LINEAGE_DELETION_STAGES, continueLineage,
  type DeployedLineage,
} from "./do-lineage.ts";
import {
  buildStageConfigs, describeStep, destructiveMigrations, stageBackendSecrets, stageGatekeeperSecrets,
  stageKvNamespaces, stageMigrations, stagePackages,
} from "./stage-config.ts";
import {
  FIRST_DEPLOY_ATTEMPTS, deployBlockers, deployRetryingFirstDeploy, destructiveMigrationBlockers, dryRunPlan,
  isFirstDeployRace, type Prepared, type WranglerResult,
} from "./stage.ts";
import { STAGES, stageDeployBlockers, type StageDefinition } from "./stages.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const packages = readDeployablePackages(PACKAGES_DIR);
const dev: StageDefinition = STAGES.dev;
const prod: StageDefinition = STAGES.prod;
const backend = packages.find((pkg) => pkg.name === "workshop-backend");
if (!backend) throw new Error("no workshop-backend package");

/** This line's own backend history, as packages/workshop-backend/wrangler.jsonc declares it. */
const CLEAN_HISTORY = [
  { tag: "v0", new_sqlite_classes: ["UserDurableObject", "OverseerDurableObject"] },
  { tag: "v1", new_sqlite_classes: ["AdminSettings"] },
  { tag: "v2", new_sqlite_classes: ["PendingLogin"] },
  { tag: "v3", new_sqlite_classes: ["UserDirectoryDurableObject"] },
  { tag: "v4", new_sqlite_classes: ["AdminAuditDurableObject"] },
];

/** dev-os's history (the archived main's, applied there), then the continuation onto this line. */
const DEV_HISTORY = [
  ...CLEAN_HISTORY.slice(0, 4),
  { tag: "v4", new_sqlite_classes: ["SubjectPresenceDurableObject"] },
  { tag: "v5", new_sqlite_classes: ["AuthoredWidgetBuildDurableObject"] },
  {
    tag: "v6",
    new_sqlite_classes: ["AdminAuditDurableObject"],
    deleted_classes: ["SubjectPresenceDurableObject", "AuthoredWidgetBuildDurableObject"],
  },
];

function configsFor(stage: StageDefinition) {
  const kv = stageKvNamespaces(stage, packages);
  return buildStageConfigs({ stage, packages, accountId: ACCOUNT, kvIds: new Map(kv.map((ns) => [ns.title, "id"])) });
}

function prepared(stageName: string, stage: StageDefinition, allowDestructiveMigrations = false): Prepared {
  const deployed = stagePackages(stage, packages);
  return {
    stageName, stage, accountId: ACCOUNT, packages: deployed,
    secrets: stageBackendSecrets({ admins: ["a@example.test"], aiGateway: {}, adminConfigSeed: {} }),
    gatekeeperSecrets: stageGatekeeperSecrets({ stageName, edgeSecret: undefined, bareEdgeSecret: undefined }),
    destructive: destructiveMigrations(stageName, stage, deployed), allowDestructiveMigrations,
  };
}

test("the deletion is pinned: exactly these two classes, on dev only", () => {
  assert.deepEqual([...ARCHIVED_MAIN_DELETED_CLASSES], ["SubjectPresenceDurableObject", "AuthoredWidgetBuildDurableObject"]);
  assert.deepEqual([...LINEAGE_DELETION_STAGES], ["dev"]);
  assert.deepEqual([...ARCHIVED_MAIN_BACKEND_LINEAGE.applied, ARCHIVED_MAIN_BACKEND_LINEAGE.continuation], DEV_HISTORY);
});

test("the package keeps this line's own history, and so does a preview", () => {
  assert.deepEqual(backend.config.migrations, CLEAN_HISTORY);
  const preview = buildPreviewConfigs({
    previewName: "pr-1", packages, accountId: ACCOUNT, workersDevHost: "example.workers.dev",
  }).get("workshop-backend");
  assert.deepEqual(preview?.migrations, CLEAN_HISTORY);
});

test("dev's generated backend config carries v0..v5 as deployed, then v6", () => {
  const config = configsFor(dev).get("workshop-backend");
  assert.deepEqual(config?.migrations, DEV_HISTORY);
  assert.deepEqual(config?.migrations?.map((m) => m.tag), ["v0", "v1", "v2", "v3", "v4", "v5", "v6"]);
  // The classes the worker ends with are all exported by this line's backend entry, and the two
  // deleted ones are not (the backend binds its Durable Objects through ctx.exports, not config).
  const live = new Set<string>();
  for (const m of DEV_HISTORY as { new_sqlite_classes: string[]; deleted_classes?: string[] }[]) {
    for (const name of m.new_sqlite_classes) live.add(name);
    for (const name of m.deleted_classes ?? []) live.delete(name);
  }
  const server = readFileSync(join(PACKAGES_DIR, "workshop-backend", "src", "server.ts"), "utf8");
  const exported = new Set([...server.matchAll(/^export \{([^}]*)\}/gm)]
    .flatMap((m) => m[1].split(",").map((name) => name.trim()).filter(Boolean)));
  for (const name of live) assert.ok(exported.has(name), `${name} is live but not exported`);
  for (const name of ARCHIVED_MAIN_DELETED_CLASSES) assert.ok(!exported.has(name), `${name} is still exported`);
});

test("a stage with no lineage, and every other package, deploys its own history", () => {
  const fresh: StageDefinition = { ...dev, backendLineage: undefined };
  assert.deepEqual(configsFor(fresh).get("workshop-backend")?.migrations, CLEAN_HISTORY);
  for (const [name, config] of configsFor(dev)) {
    if (name === "workshop-backend") continue;
    const own = packages.find((pkg) => pkg.name === name)?.config.migrations;
    assert.deepEqual(config.migrations, own, name);
  }
});

test("prod names the same lineage, but its deploy is refused: unverified, and not allowed the deletion", () => {
  assert.equal(prod.backendLineage?.lineage, ARCHIVED_MAIN_BACKEND_LINEAGE);
  assert.equal(prod.backendLineage?.verified, null);
  assert.deepEqual(configsFor(prod).get("workshop-backend")?.migrations, DEV_HISTORY);
  assert.match(stageDeployBlockers(prod).join("\n"), /lineage is unverified/);
  const prep = prepared("prod", prod);
  assert.deepEqual(prep.destructive.declared, []);
  assert.deepEqual(prep.destructive.refused.map(describeStep), [
    "workshop-backend migration v6: deleted_classes SubjectPresenceDurableObject, AuthoredWidgetBuildDurableObject",
  ]);
  const plan = dryRunPlan(prep);
  assert.match(plan, /REFUSED[\s\S]*lineage is unverified[\s\S]*destroy or move state/);
  // Even with the flag, the unverified lineage still refuses it.
  assert.match(deployBlockers(prepared("prod", prod, true)).join("\n"), /unverified/);
});

test("the declared deletion is allowed on dev; anything else destructive is still refused", () => {
  const ok = prepared("dev", dev);
  assert.deepEqual(ok.destructive.refused, []);
  assert.deepEqual(ok.destructive.declared.map(describeStep), [
    "workshop-backend migration v6: deleted_classes SubjectPresenceDurableObject, AuthoredWidgetBuildDurableObject",
  ]);
  assert.deepEqual(deployBlockers(ok), []);

  // The same lineage under another stage name is refused.
  assert.equal(destructiveMigrations("staging", dev, stagePackages(dev, packages)).refused.length, 1);
  // A copy of the lineage is not the declared one: the allowance is by identity, not by shape.
  const copy: StageDefinition = { ...dev, backendLineage: { lineage: structuredClone(ARCHIVED_MAIN_BACKEND_LINEAGE), verified: "x" } };
  assert.equal(destructiveMigrations("dev", copy, stagePackages(copy, packages)).refused.length, 1);
  // Another package's destructive migration on dev is refused, unless the flag is passed.
  const gatekeeper = packages.find((pkg) => pkg.name === "gatekeeper-context");
  if (!gatekeeper) throw new Error("no gatekeeper-context package");
  const extra = [...stagePackages(dev, packages).filter((pkg) => pkg !== gatekeeper), {
    ...gatekeeper,
    config: { ...gatekeeper.config, migrations: [...(gatekeeper.config.migrations ?? []),
      { tag: "v1", deleted_classes: ["UserLibraryDurableObject"] }] },
  }];
  const mixed = destructiveMigrations("dev", dev, extra);
  assert.equal(mixed.declared.length, 1);
  assert.deepEqual(mixed.refused.map(describeStep), ["gatekeeper-context migration v1: deleted_classes UserLibraryDurableObject"]);
  assert.match(destructiveMigrationBlockers({ destructive: mixed, allowDestructiveMigrations: false }).join(""),
    /--allow-destructive-migrations/);
  assert.deepEqual(destructiveMigrationBlockers({ destructive: mixed, allowDestructiveMigrations: true }), []);
});

test("dev's dry run shows the migration plan and refuses nothing", () => {
  const plan = dryRunPlan(prepared("dev", dev));
  assert.doesNotMatch(plan, /REFUSED/);
  assert.match(plan, /inferos-dev-workshop-backend: v0, v1, v2, v3, v4, v5, v6, continuing the archived main lineage \(verified\)/);
  assert.match(plan, /already applied there: v0 UserDurableObject \+ OverseerDurableObject;.*v5 AuthoredWidgetBuildDurableObject/);
  assert.match(plan, /v6 adds AdminAuditDurableObject; DELETES SubjectPresenceDurableObject, AuthoredWidgetBuildDurableObject and their storage \(declared for this stage\)/);
  assert.match(plan, /inferos-dev-gatekeeper-context: v0 \(this line's own history\)/);
});

test("a lineage that no longer matches this line's history fails the run", () => {
  const own = backend.config.migrations ?? [];
  const lineage = ARCHIVED_MAIN_BACKEND_LINEAGE;
  const variant = (continuation: DeployedLineage["continuation"]): DeployedLineage => ({ ...lineage, continuation });
  // A new migration on this line needs the lineage's next step declared.
  assert.throws(() => continueLineage([...own, { tag: "v5", new_sqlite_classes: ["NewThing"] }], lineage),
    /must add exactly this line's AdminAuditDurableObject, NewThing/);
  // Deleting more, or fewer, than the lineage's own classes.
  assert.throws(() => continueLineage(own, variant({ ...lineage.continuation,
    deleted_classes: [...ARCHIVED_MAIN_DELETED_CLASSES, "UserDurableObject"] })), /must delete exactly/);
  assert.throws(() => continueLineage(own, variant({ ...lineage.continuation,
    deleted_classes: ["SubjectPresenceDurableObject"] })), /must delete exactly/);
  // Doing anything besides adding and deleting, or reusing a tag.
  assert.throws(() => continueLineage(own, variant({ ...lineage.continuation,
    renamed_classes: [{ from: "A", to: "B" }] })), /also does renamed_classes/);
  assert.throws(() => continueLineage(own, variant({ ...lineage.continuation, tag: "v5" })), /already in the lineage/);
  // A shared prefix that differs, or a lineage this line has caught up with.
  assert.throws(() => continueLineage([{ tag: "v0", new_sqlite_classes: ["Other"] }], lineage), /shares no migration/);
  assert.throws(() => continueLineage(lineage.applied, lineage), /adds nothing/);
  // The stage path runs the same check.
  assert.throws(() => stageMigrations(dev, { name: "workshop-backend", config: { ...backend.config,
    migrations: [...own, { tag: "v5", new_sqlite_classes: ["NewThing"] }] } }), /must add exactly/);
});

/** What wrangler prints when a first deploy races its own creation (dev-os, 2026-11-23). */
const RACE: WranglerResult = {
  status: 1,
  stdout: "Total Upload: 512.00 KiB / gzip: 128.00 KiB\nUploaded inferos-dev-gatekeeper-inferlab (3.21 sec)\n",
  stderr: "✘ [ERROR] A request to the Cloudflare API (/accounts/x/workers/scripts/inferos-dev-gatekeeper-inferlab/secrets) failed.\n\n" +
    "  This Worker does not exist on your account. [code: 10007]\n",
};
const OK: WranglerResult = { status: 0, stdout: "Uploaded x\nDeployed x triggers\n", stderr: "" };

/** A stubbed wrangler: answers each attempt from `results`, recording the calls and the waits. */
function stubbed(results: WranglerResult[]) {
  const waits: number[] = [];
  let calls = 0;
  const run = () => Promise.resolve(results[Math.min(calls++, results.length - 1)]);
  const sleep = (ms: number) => { waits.push(ms); return Promise.resolve(); };
  return { run, sleep, waits, calls: () => calls };
}

test("the first-deploy race is recognized only after an upload that answered 10007", () => {
  assert.equal(isFirstDeployRace(RACE), true);
  assert.equal(isFirstDeployRace({ ...RACE, stderr: '{"code":10007,"message":"This Worker does not exist"}' }), true);
  assert.equal(isFirstDeployRace({ ...RACE, stdout: "Total Upload: 512.00 KiB\n" }), false, "nothing was uploaded");
  assert.equal(isFirstDeployRace({ ...RACE, stderr: "✘ [ERROR] Authentication error [code: 10000]" }), false);
  assert.equal(isFirstDeployRace({ ...RACE, stderr: "error [code: 100070]" }), false);
  assert.equal(isFirstDeployRace({ ...RACE, status: 0 }), false);
});

test("a first deploy that races its creation is retried, bounded; nothing else is", async () => {
  const once = stubbed([RACE, OK]);
  assert.equal((await deployRetryingFirstDeploy("w", once.run, once.sleep)).status, 0);
  assert.equal(once.calls(), 2);
  assert.deepEqual(once.waits, [5_000]);

  const always = stubbed([RACE]);
  await assert.rejects(deployRetryingFirstDeploy("w", always.run, always.sleep), /still "This Worker does not exist" \(10007\) after 3 attempts/);
  assert.equal(always.calls(), FIRST_DEPLOY_ATTEMPTS);
  assert.deepEqual(always.waits, [5_000, 15_000]);

  const other = stubbed([{ ...RACE, stderr: "✘ [ERROR] 10074 Cannot apply new-sqlite-class migration" }, OK]);
  await assert.rejects(deployRetryingFirstDeploy("w", other.run, other.sleep), /wrangler deploy failed for w with exit code 1/);
  assert.equal(other.calls(), 1);
  assert.deepEqual(other.waits, []);
});
