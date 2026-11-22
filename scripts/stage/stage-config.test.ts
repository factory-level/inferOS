// FAC-296: the persistent stage's configs and dry-run plan, built from this checkout's real
// packages with no network and no Cloudflare account. Secret inputs are sentinels, so a value that
// leaked into a config or the plan would be found.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isGatekeeperPackage, readDeployablePackages } from "../release/manifest-lib.ts";
import { PACKAGES_DIR } from "../preview/staging-config.ts";
import {
  buildStageConfigs, destructiveMigrations, formatStagePlan, resolveStageAdmins, stageBackendSecrets,
  stageBucketName, stageKvNamespaces, stageKvTitle, stagePackages, stageTiers, stageWorkerName,
} from "./stage-config.ts";
import { dryRunPlan, isAccessRedirect, parseStageArgs, type Prepared } from "./stage.ts";
import {
  INFERLAB_GATEKEEPER, INFERLABOPS_GATEKEEPER, STAGES, STAGE_GATEKEEPERS, resolveStage,
  stageDefinitionProblems, stageDeployBlockers, type StageDefinition,
} from "./stages.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TENANT = "11111111-2222-4333-8444-555555555555";
const SECRET = {
  admins: ["admin-sentinel@example.test"],
  aiGateway: {
    CF_AI_GATEWAY: "gateway-sentinel-value",
    CF_AI_GATEWAY_ACCOUNT_ID: "account-sentinel-value",
    CF_AI_GATEWAY_PROVIDERS: "anthropic-sentinel-value",
  },
};
const packages = readDeployablePackages(PACKAGES_DIR);
const dev: StageDefinition = STAGES.dev;
/** dev, as it is once InferOps maps dev-os to a tenant id. */
const devWithCompany: StageDefinition = { ...dev, inferops: { ...dev.inferops, company: TENANT } };

function configsFor(stage: StageDefinition) {
  const kv = stageKvNamespaces(stage, packages);
  return buildStageConfigs({
    stage, packages, accountId: ACCOUNT, kvIds: new Map(kv.map((ns) => [ns.title, `id-${ns.title}`])),
  });
}

function prepared(stage: StageDefinition): Prepared {
  return {
    stageName: "dev", stage, accountId: ACCOUNT, packages: stagePackages(stage, packages),
    secrets: stageBackendSecrets(SECRET),
  };
}

test("a stage deploys the backend, the router and exactly its gatekeepers, under prefixed names", () => {
  const configs = configsFor(dev);
  const names = [...configs.keys()].toSorted();
  assert.deepEqual(names, [...STAGE_GATEKEEPERS, "router", "workshop-backend"].toSorted());
  for (const [pkg, config] of configs) {
    assert.equal(config.name, stageWorkerName(dev, pkg));
    assert.ok((config.name as string).startsWith("inferos-dev-"));
    assert.equal(config.account_id, ACCOUNT);
  }
  assert.deepEqual(stageTiers(configs).map((t) => t.packages), [
    [...STAGE_GATEKEEPERS].toSorted(), ["workshop-backend"], ["router"],
  ]);
});

test("only the router has a hostname: no workers.dev, no preview URL, no route anywhere else", () => {
  for (const [pkg, config] of configsFor(dev)) {
    assert.equal(config.workers_dev, false, pkg);
    assert.equal(config.preview_urls, false, pkg);
    assert.equal(config.previews, undefined, pkg);
    if (pkg === "router") {
      assert.deepEqual(config.routes, [{ pattern: "dev-os.factorylevel.dev", custom_domain: true }]);
    } else {
      assert.equal(config.routes, undefined, pkg);
    }
  }
});

test("the backend binds every stage gatekeeper by its stage worker name, and the router binds them all", () => {
  const configs = configsFor(dev);
  const backend = configs.get("workshop-backend");
  const services = (backend?.services ?? []) as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(services.map((s) => s.service).toSorted(),
    STAGE_GATEKEEPERS.map((g) => stageWorkerName(dev, g)).toSorted());
  for (const s of services) assert.equal(s.entrypoint, "GatekeeperVendor");
  const context = services.find((s) => s.service === "inferos-dev-gatekeeper-context");
  assert.deepEqual(context?.props, { sharingDomain: "https://dev-os.factorylevel.dev" });
  assert.deepEqual(backend?.ai, { binding: "WORKERS_AI" });

  const router = configs.get("router");
  const routed = ((router?.services ?? []) as unknown as Array<Record<string, unknown>>).map((s) => s.service);
  assert.deepEqual(routed.toSorted(), ["inferos-dev-workshop-backend",
    ...STAGE_GATEKEEPERS.map((g) => stageWorkerName(dev, g))].toSorted());
});

test("the InferLab gatekeepers get the stage's sign-in origin and company; every gatekeeper its BASE_URL", () => {
  const configs = configsFor(devWithCompany);
  for (const pkg of STAGE_GATEKEEPERS) {
    const short = pkg.slice("gatekeeper-".length);
    assert.equal(configs.get(pkg)?.vars?.BASE_URL, `https://dev-os.factorylevel.dev/gatekeeper/${short}`);
  }
  for (const pkg of [INFERLAB_GATEKEEPER, INFERLABOPS_GATEKEEPER]) {
    assert.equal(configs.get(pkg)?.vars?.INFERLAB_AUTH_ORIGIN, "https://auth.dev.inferlab.io");
    assert.equal(configs.get(pkg)?.vars?.INFEROPS_COMPANY, TENANT);
  }
  assert.equal(configs.get("gatekeeper-context")?.vars?.INFEROPS_COMPANY, undefined);
});

test("the backend signs people in with InferLab only, and its vars hold no secret", () => {
  const vars = configsFor(dev).get("workshop-backend")?.vars ?? {};
  assert.equal(vars.PUBLIC_BASE_URL, "https://dev-os.factorylevel.dev");
  assert.equal(vars.AUTH_GATEKEEPERS, "inferlab");
  assert.equal(vars.AUTH_GATEKEEPER_ISSUERS, "inferlab=https://auth.dev.inferlab.io");
  assert.equal(vars.DISABLE_PASSWORD_AUTH, "true");
  for (const name of ["ADMINS", "CF_ACCESS_AUD", "CF_ACCESS_ISS", "CF_AI_GATEWAY"]) {
    assert.equal(vars[name], undefined, name);
  }
});

test("KV namespaces and buckets get stable stage names, and a missing KV id fails the build", () => {
  const kv = stageKvNamespaces(dev, packages);
  assert.ok(kv.length > 0);
  for (const ns of kv) assert.equal(ns.title, stageKvTitle(dev, ns.pkgName, ns.binding));
  assert.ok(kv.every((ns) => ns.title.startsWith("inferos-dev-")));
  const backend = configsFor(dev).get("workshop-backend");
  for (const bucket of backend?.r2_buckets ?? []) {
    assert.equal((bucket as unknown as { bucket_name: string }).bucket_name, stageBucketName(dev, bucket.binding));
  }
  assert.throws(() => buildStageConfigs({ stage: dev, packages, accountId: ACCOUNT, kvIds: new Map() }),
    /no KV namespace id/);
});

test("the backend's secrets are ADMINS and the AI Gateway names, and no value reaches a config", () => {
  const secrets = stageBackendSecrets(SECRET);
  assert.deepEqual(Object.keys(secrets),
    ["ADMINS", "CF_AI_GATEWAY", "CF_AI_GATEWAY_ACCOUNT_ID", "CF_AI_GATEWAY_PROVIDERS"]);
  const everything = JSON.stringify([...configsFor(dev).values()]);
  for (const value of [...SECRET.admins, ...Object.values(SECRET.aiGateway)]) {
    assert.ok(!everything.includes(value), `a secret value reached a config: ${value}`);
  }
  assert.throws(() => resolveStageAdmins({ list: " , " }), /STAGE_ADMINS/);
});

test("the dry run lists every worker and the backend's secret names, with no value, and needs no network", () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("the dry run touched the network"); }) as typeof fetch;
  let plan: string;
  try {
    plan = dryRunPlan(prepared(dev));
  } finally {
    globalThis.fetch = realFetch;
  }
  for (const pkg of [...STAGE_GATEKEEPERS, "workshop-backend", "router"]) {
    assert.match(plan, new RegExp(`\\b${stageWorkerName(dev, pkg)}\\b`));
  }
  assert.match(plan,
    /inferos-dev-workshop-backend, secrets: ADMINS, CF_AI_GATEWAY, CF_AI_GATEWAY_ACCOUNT_ID, CF_AI_GATEWAY_PROVIDERS/);
  assert.equal(plan.match(/\(custom domain\)/g)?.length, 1);
  assert.match(plan, /inferos-dev-router at dev-os\.factorylevel\.dev \(custom domain\)/);
  for (const value of [...SECRET.admins, ...Object.values(SECRET.aiGateway), ACCOUNT]) {
    assert.ok(!plan.includes(value), `the plan printed a value: ${value}`);
  }
});

test("a company's tenant id never appears in the plan", () => {
  const plan = dryRunPlan(prepared(devWithCompany));
  assert.ok(!plan.includes(TENANT));
  assert.match(plan, /company tenant id set/);
  assert.doesNotMatch(plan, /REFUSED/);
});

test('a stage whose company is "internal" plans, but the plan says the deploy refuses it', () => {
  assert.equal(stageDeployBlockers(dev).length, 1);
  assert.deepEqual(stageDeployBlockers(devWithCompany), []);
  assert.match(dryRunPlan(prepared(dev)), /REFUSED[\s\S]*INFEROPS_COMPANY must be a tenant id/);
});

test("stage definitions are checked before anything is generated", () => {
  assert.deepEqual(stageDefinitionProblems(dev), []);
  assert.deepEqual(stageDefinitionProblems(STAGES.prod), []);
  const bad: StageDefinition = {
    ...dev, hostname: "Dev-OS.example", workerPrefix: "inferos-dev",
    inferops: { authOrigin: "https://auth.dev.inferlab.io/path", company: "acme" },
    gatekeepers: ["gatekeeper-context"],
  };
  const problems = stageDefinitionProblems(bad).join("\n");
  for (const needle of ["hostname", "workerPrefix", "authOrigin", "company", INFERLAB_GATEKEEPER, INFERLABOPS_GATEKEEPER]) {
    assert.match(problems, new RegExp(needle));
  }
  assert.throws(() => resolveStage("staging"), /unknown stage/);
  assert.throws(() => stagePackages({ ...dev, gatekeepers: ["gatekeeper-nope"] }, packages), /gatekeeper-nope/);
});

test("the stage's gatekeepers are deployable packages here, and the rest are left out", () => {
  const deployed = stagePackages(dev, packages).map((p) => p.name).filter(isGatekeeperPackage);
  assert.deepEqual(deployed.toSorted(), [...STAGE_GATEKEEPERS].toSorted());
  assert.ok(packages.filter((p) => isGatekeeperPackage(p.name)).length > STAGE_GATEKEEPERS.length);
});

test("destructive Durable Object migrations are named", () => {
  assert.deepEqual(destructiveMigrations(stagePackages(dev, packages)), []);
  assert.deepEqual(destructiveMigrations([{ name: "x", config: {
    name: "x", migrations: [{ tag: "v9", deleted_classes: ["Old"] }],
  } as never }]), ["x migration v9: deleted_classes"]);
});

test("arguments: config and deploy, a named stage, and only the known flags", () => {
  assert.deepEqual(parseStageArgs(["deploy", "dev", "--dry-run"]), {
    command: "deploy", stage: "dev", dryRun: true, allowDirty: false, allowDestructiveMigrations: false,
  });
  assert.throws(() => parseStageArgs(["delete", "dev"]), /Usage/);
  assert.throws(() => parseStageArgs(["deploy", "--dry-run"]), /name a stage/);
  assert.throws(() => parseStageArgs(["deploy", "dev", "--force"]), /unknown argument/);
});

test("only a redirect to Cloudflare Access counts as behind Access", () => {
  assert.equal(isAccessRedirect({ status: 302, location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" }), true);
  assert.equal(isAccessRedirect({ status: 200, location: null }), false);
  assert.equal(isAccessRedirect({ status: 302, location: "https://evil.example/cloudflareaccess.com" }), false);
  assert.equal(isAccessRedirect({ status: 302, location: "not a url" }), false);
});

test("the plan formats what it is given", () => {
  const configs = configsFor(devWithCompany);
  const plan = formatStagePlan({
    stageName: "dev", stage: devWithCompany, configs, secretNames: ["ADMINS"], kv: [],
  });
  assert.match(plan, /^stage "dev" -> https:\/\/dev-os\.factorylevel\.dev/);
  assert.match(plan, /R2 buckets:/);
});
