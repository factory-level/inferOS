import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, stubFor, waitFor,
  WorkpieceRecorder,
} from "../src/rpc-client.js";

// FAC-232: a fresh instantiation of the bundled Review Alerts blueprint is a new workspace of the
// installer's own, bound only to what this install made, holding nothing copied from anywhere.
//
// Mutation note. Each guarantee below was checked by breaking it and watching this file fail:
// - a copied state: `Gadget`'s constructor in blueprints/review-alerts/files/server.ts made to
//   store a key, so the instantiated gadget does not start empty;
// - a stale binding: an extra connection bound into copy A after its install, so the gadget's
//   bindings are no longer only the one this install made.
// Giving the assignment another person's account id is not a mutation that can fail here: account
// ids are numbered per person (both people's first account is 0), and newWorkspaceFromBlueprint()
// resolves the id among the installer's own accounts, so it names the installer's account again.
// The action check below is what shows the connection acts as the installer's account alone.
//
// The harness has no InferLab operations gatekeeper (its accounts come from a live InferOps
// sign-in), so the "with a connection" case assigns the fixture gatekeeper's account to PROJECT.
// The kernel accepts that: newWorkspaceFromBlueprint() does not check an assignment's vendor
// against the binding's gatekeeperName. What is proved here is the wiring an install makes, not
// what an InferOps Project returns; the server's reading of one is the blueprint's own tests.

const REVIEW_ALERTS = "inferlab.review-alerts";

type ReviewAlertsGadget = {
  getReviewAlerts(): Promise<{ state: string; message?: string }>;
  storedKeyCount(): Promise<number>;
};

let harness: Harness | undefined;
// Nothing here talks to a model or a vendor; the interceptor makes sure of it.
const network = new NetworkInterceptor({ handlers: [] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
    await harness?.server.close();
  }
});

function requireHarness(): Harness {
  if (harness === undefined) throw new Error("Workshop harness did not start");
  return harness;
}

/** The bundled release the deployment installed: what a fresh gadget must name as its upstream. */
async function installedRelease(publicApi: RpcStub<PublicApi>, api: RpcStub<AuthenticatedApi>) {
  const offer = await waitFor("the Review Alerts format to install", async () =>
    (await api.listOutputFormats()).find(format => format.blueprintId === REVIEW_ALERTS) ?? null);
  expect(offer.output).toEqual({
    id: "review-alerts", noun: "Review Alerts", plural: "Review Alerts", icon: "listChecks",
  });
  const blueprint = await publicApi.getBlueprint(REVIEW_ALERTS);
  expect(blueprint?.metadata.bindings).toEqual({
    PROJECT: {
      title: "InferOps Project",
      description: "Connect the InferLab operations Project whose Locations waiting for review this shows.",
      type: "gatekeeper",
      gatekeeperName: "inferlabops",
      typeUrlPattern: "inferops://*.*/project/project/*",
    },
  });
  const release = blueprint?.metadata.commitId;
  if (!release) throw new Error("Review Alerts has no release");
  return release;
}

/** What one instantiation produced, read back through the workspace's own API. */
async function inspect(workspace: RpcStub<Overseer>) {
  const metadata = await workspace.getMetadata();
  const gadgetId = metadata.defaultGadgetId;
  if (gadgetId === undefined) throw new Error("The workspace has no default Gadget");
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _subscription = await workspace.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;
  const summaries = [...workpieces.summaries.values()];
  const gadget = summaries.find(summary => summary.id === gadgetId);
  if (gadget?.type !== "gadget") throw new Error("The default workpiece is not a Gadget");
  using client = await workspace.getGadget(gadgetId);
  using facet = await client.connectToGadget() as RpcStub<ReviewAlertsGadget>;
  return {
    id: metadata.id,
    gadgetId,
    upstream: gadget.upstream,
    gadgets: summaries.filter(summary => summary.type === "gadget").length,
    bindings: await client.listBindings(),
    hooks: await workspace.listHooks(),
    storedKeys: await facet.storedKeyCount(),
    alerts: await facet.getReviewAlerts(),
  };
}

it("instantiates Review Alerts unbound: a new, empty workspace that says it is not connected",
    async () => {
  const [installer] = nextUsernames("reviewalerts");
  if (!installer) throw new Error("Failed to allocate a test username");
  using publicApi = connect(requireHarness().url);
  using api = await signUp(publicApi, installer);
  const release = await installedRelease(publicApi, api);

  using first = await api.newWorkspaceFromBlueprint(REVIEW_ALERTS, {});
  using second = await api.newWorkspaceFromBlueprint(REVIEW_ALERTS, {});
  const [a, b] = [await inspect(first), await inspect(second)];

  // Two instantiations, two workspaces, each addressed by its 64-hex Overseer id (the
  // `<workspaceDoId>` of an `inferos/gadget` address).
  expect(a.id).not.toBe(b.id);
  for (const copy of [a, b]) {
    expect(copy.id).toMatch(/^[0-9a-f]{64}$/);
    expect(copy.gadgets).toBe(1);
    expect(copy.upstream).toEqual({ blueprintId: REVIEW_ALERTS, commitId: release });
    expect(copy.bindings).toEqual([]);
    expect(copy.hooks).toEqual([]);
    expect(copy.storedKeys).toBe(0);
    expect(copy.alerts).toEqual({
      state: "notConnected", message: "Not connected: connect an InferLab operations Project.",
    });
  }

  // Independent: deleting one leaves the other as it was.
  await first.deleteSelf();
  expect(await inspect(second)).toEqual(b);
  await second.deleteSelf();
});

it("instantiates Review Alerts with a connection bound to the installer's own account, and nothing else",
    async () => {
  const [installer, other] = nextUsernames("reviewalertsowner", "reviewalertsother");
  if (!installer || !other) throw new Error("Failed to allocate test usernames");
  using otherPublic = connect(requireHarness().url);
  using otherApi = await signUp(otherPublic, other);
  await otherApi.provisionAmbientAccount(TEST_VENDOR_ID);
  const otherAccount = (await listConnectedAccounts(otherApi))
      .find(account => account.vendorId === TEST_VENDOR_ID);
  if (!otherAccount) throw new Error("The other person's test account was not provisioned");

  using publicApi = connect(requireHarness().url);
  using api = await signUp(publicApi, installer);
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = (await listConnectedAccounts(api))
      .find(candidate => candidate.vendorId === TEST_VENDOR_ID);
  if (!account) throw new Error("The installer's test account was not provisioned");
  const release = await installedRelease(publicApi, api);

  const install = (key: string) => api.newWorkspaceFromBlueprint(REVIEW_ALERTS, {
    PROJECT: {
      type: "gatekeeper",
      accountId: account.id,
      resourceUrl: `https://gadgets-test.example/things/review-alerts-${key}`,
    },
  });
  using first = await install("a");
  using second = await install("b");
  const [a, b] = [await inspect(first), await inspect(second)];

  expect(a.id).not.toBe(b.id);
  for (const [copy, key] of [[a, "a"], [b, "b"]] as const) {
    expect(copy.upstream).toEqual({ blueprintId: REVIEW_ALERTS, commitId: release });
    // One binding, to the connection this install made, under the blueprint's name.
    expect(copy.bindings).toEqual([
      expect.objectContaining({ name: "PROJECT", vendorId: TEST_VENDOR_ID }),
    ]);
    expect(copy.bindings[0]?.target).not.toBe(copy.gadgetId);
    expect(copy.hooks).toEqual([]);
    expect(copy.storedKeys).toBe(0);
    // A connection that is not InferLab operations is reported, never shown as an empty list.
    expect(copy.alerts).toMatchObject({ state: "failed" });

    const workspace = key === "a" ? first : second;
    using client = await workspace.getGadget(copy.gadgetId);
    using binding = await client.getBinding("PROJECT");
    if (!binding) throw new Error("The installed Gadget has no PROJECT binding");
    expect(await binding.getCreationSpec()).toMatchObject({
      type: "gatekeeper",
      vendorId: TEST_VENDOR_ID,
      resourceUrl: `https://gadgets-test.example/things/review-alerts-${key}`,
    });
  }

  // The connection acts as the installer's own account, and not anyone else's: an action through
  // copy A lands on the installer's test account alone.
  using client = await first.getGadget(a.gadgetId);
  using binding = await client.getBinding("PROJECT");
  using session = await binding!.openSession() as RpcStub<TestSession>;
  const write = session.writeValue(23);
  const [pending] = await waitFor("the installed connection's action", async () => {
    const { entries } = await first.listActions({ filter: "pending" });
    return entries.length === 1 ? entries : null;
  });
  await first.approveAction(pending.id);
  await write;
  expect(await testActionState(requireHarness(), accountLabel(account)))
      .toEqual({ pending: [], value: 23, applyCount: 1 });
  expect(await testActionState(requireHarness(), accountLabel(otherAccount)))
      .toEqual({ pending: [], applyCount: 0 });
  // ...and copy B, a workspace of its own, saw none of it.
  expect((await second.listActions({ filter: "pending" })).entries).toEqual([]);

  await first.deleteSelf();
  await second.deleteSelf();
});
