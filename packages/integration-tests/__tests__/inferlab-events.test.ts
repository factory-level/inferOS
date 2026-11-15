// FAC-236 end to end through the real Workshop and the real InferLab gatekeepers, with only InferOps
// faked (inferlab-fake.ts): the owner signs in by their InferLab subject, connects their own
// operations account and binds a Project; a Gadget subscribes a hook on its events; the owner
// enables it; a signed delivery from InferOps fires the hook, which raises attention (FAC-237), and
// the owner's Home lists it. A duplicate delivery, a revoked grant and a disabled hook fire nothing.

import { afterAll, beforeAll, expect, it } from "vitest";
import { startHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, waitFor, waitForIdleChat } from "../src/rpc-client.js";
import {
  ADDRESS, FakeInferOps, LOC, WS, connectOperations, operationsGatekeeper, patchWorkshop, signInGatekeeper, signInOwner,
} from "./inferlab-fake.js";

const inferops = new FakeInferOps();
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler, inferops.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [signInGatekeeper(), operationsGatekeeper()],
    enableGadgetExecution: true,
    patchWorkshop,
  });
}, 300_000);

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/** A Gadget whose `reviews` hook raises attention for each review requested on the Project. */
const REVIEWS_SERVER = `import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async [restore](params) {
    if (params.type !== "reviews") throw new TypeError("Unknown restore type: " + params.type);
    return new Reviews(this.env);
  }
}
class Reviews extends RpcTarget {
  constructor(env) { super(); this.env = env; }
  async receiveEvent(event) {
    await this.env.ATTENTION.raise({
      v: 1, sourceEventId: event.eventId, reason: "review_requested", target: event.location.ref,
      audience: { kind: "permission-holders", workspaceId: "${WS}", permission: "location:review" },
    });
  }
}`;

const SUBSCRIBE = `import { restore } from "cloudflare:workers";
export default async function(self, env) {
  await env.INFEROPS_PROJECT.subscribe(await env.HOOKED.rpc[restore]({ type: "reviews" }));
}`;

let eventSeq = 0;
const nextEventId = () => `7a2d3b9f-5c2e-4d66-8b4f-${(++eventSeq).toString(16).padStart(12, "0")}`;

it("a signed InferOps event fires the Gadget's hook once, which raises attention on the owner's Home", async () => {
  using stack = new DisposableStack();
  const pub = stack.use(connect(harness.url));
  const api = stack.use(await signInOwner(harness, pub));
  const account = await connectOperations(harness, api);

  // The Gadget is built and subscribes through chat turns, as the agent would.
  const model = models.script([
    { toolCall: { id: "server", name: "writeFile", arguments: { workpiece: "HOOKED", filename: "server.js", content: REVIEWS_SERVER } } },
    { text: "Built." },
    { toolCall: { id: "subscribe", name: "executeCode", arguments: { code: SUBSCRIBE } } },
    { text: "Subscribed." },
  ]);
  await api.addModel(model.userModel.profile, model.userModel.config);
  const ws = stack.use(await api.newWorkspace());
  const connection = await ws.newGatekeeper(account.id, ADDRESS);
  if (!connection) throw new Error("Failed to bind the Project");
  stack.use(connection);
  using hooked = await ws.createGadget("Hooked", undefined, "HOOKED");
  await hooked.bind("INFEROPS_PROJECT", await connection.getId());
  const chatId = await ws.newChat("Build the reviews hook.", SCRIPTED_MODEL_ID);
  await waitFor("the build turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  expect((await ws.mergeChanges(chatId)).outcome).toBe("merged");
  await ws.sendChatMessage(chatId, "Subscribe it.", SCRIPTED_MODEL_ID);
  await waitFor("the subscribe turn", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, chatId);
  expect(model.remainingSteps()).toBe(0);

  // Bound disabled: an event before the owner enables it fires nothing.
  const [hook] = await ws.listHooks();
  expect(hook).toMatchObject({ enabled: false, description: { title: expect.stringContaining("Watch InferOps Project") } });
  const early = inferops.commit(nextEventId());
  expect((await inferops.deliver(harness, early)).status).toBe(202);

  await ws.enableHook(hook!.id);
  const event = inferops.commit(nextEventId());
  expect(await inferops.deliver(harness, event)).toEqual({ status: 202, body: { accepted: true, duplicate: false } });
  const item = await waitFor("the attention item on the owner's Home", async () =>
    (await api.getAttentionItems()).find(i => i.sourceEventId === event.eventId) ?? null, 60_000);
  expect(item).toMatchObject({ reason: "review_requested", target: { kind: "project/location", id: LOC } });
  // The raise checked the event was really committed, once.
  expect(inferops.verifyReads(String(event.eventId))).toBe(1);
  expect(inferops.verifyReads(String(early.eventId))).toBe(0);

  // The same delivery again (InferOps retries a timeout with the same id) fires nothing.
  expect(await inferops.deliver(harness, event)).toEqual({ status: 202, body: { accepted: true, duplicate: true } });

  // A revoked grant: acknowledged, and the hook is never called (nothing is raised for it).
  inferops.granted = false;
  const locationReads = () => inferops.requests.filter(r => r === `GET /project/locations/${LOC}`).length;
  const readsBefore = locationReads();
  const revoked = inferops.commit(nextEventId());
  expect((await inferops.deliver(harness, revoked)).status).toBe(202);
  // Restored only once the facet has re-read the Location for this delivery, and been refused.
  await waitFor("the delivery's re-read as the owner", async () => locationReads() > readsBefore || null, 60_000);
  inferops.granted = true;

  // Disabled: acknowledged, and nothing reaches the Gadget.
  await ws.disableHook(hook!.id);
  const disabled = inferops.commit(nextEventId());
  expect((await inferops.deliver(harness, disabled)).status).toBe(202);

  // Enabled again: a fresh event fires it again, so the quiet above was the hook's state, not a stall.
  await ws.enableHook(hook!.id);
  const again = inferops.commit(nextEventId());
  expect((await inferops.deliver(harness, again)).status).toBe(202);
  await waitFor("the second attention item", async () =>
    (await api.getAttentionItems()).find(i => i.sourceEventId === again.eventId) ?? null, 60_000);
  expect(inferops.verifyReads(String(event.eventId))).toBe(1);
  expect(inferops.verifyReads(String(revoked.eventId))).toBe(0);
  expect(inferops.verifyReads(String(disabled.eventId))).toBe(0);
}, 300_000);
