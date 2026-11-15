import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AttentionItem, AttentionTarget } from "@gadgets/workshop-shared/api";
import type { GatekeeperSubject } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";
import { OverseerDurableObject } from "../src/overseer.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";
import { subjectAccountName } from "../src/account-subject.js";
import { ATTENTION_BINDING_NAME, MAX_ATTENTION_LABEL, acceptedInferWorkUrl, accountSubject, attentionItemKey,
  cleanAttentionLabel, inferWorkOriginsFrom, parseAttentionIntent, type AttentionAuthority } from "../src/attention.js";
import type { AttentionIntent } from "../src/attention-binding";
// The InferLab contract fixtures, pinned from inferops (scripts/inferlab-contracts).
import intentFixtures from "../../../scripts/inferlab-contracts/fixtures/inferlab.attention-intent.v1.json";
import itemFixtures from "../../../scripts/inferlab-contracts/fixtures/inferlab.attention-item.v1.json";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Host attention (FAC-237, attention.ts): env.ATTENTION refuses anything but an accepted gadget's
// own, well-formed intent; the authority (a fake here; FAC-235 provides InferLab's) decides who
// may see what; each recipient gets one durable item per event, whose visibility is re-checked on
// every read.

type Impl = OverseerDurableObject["impl"];
const ISSUER = "http://localhost:8080";
const subject = (id: string): GatekeeperSubject => ({issuer: ISSUER, subject: id});
const INTENT: AttentionIntent = intentFixtures.valid[0]!.value as AttentionIntent;

/** A committed InferLab event, as the fake authority knows it. */
type FakeEvent = {tenantId: string; kind: string; id: string; type: string; workspaceId: string};
const REVIEW_EVENT_TYPE = "project.location.review_requested";
const eventOf = (intent: AttentionIntent): FakeEvent => ({tenantId: intent.target.tenantId,
  kind: intent.target.kind, id: intent.target.id, type: REVIEW_EVENT_TYPE,
  workspaceId: intent.audience.workspaceId});
const LATER_EVENT = "6f1c2a8e-4b1d-4c55-9a3e-2f6d8b1e0a02";

/**
 * A fake InferLab authority: which committed events exist, who holds the audience permission, and
 * what each person can see. Its verifyEvent is the strict contract the interface documents.
 */
class FakeAuthority implements AttentionAuthority {
  approved = true;
  events = new Map<string, FakeEvent>([[INTENT.sourceEventId, eventOf(INTENT)],
    [LATER_EVENT, eventOf(INTENT)]]);
  failEvents = false;
  verified: string[] = [];
  verifiedAs: string[] = [];
  holders = new Set<string>();      // account names in the audience
  hidden = new Set<string>();       // `${accountName}|${targetId}` the person can't see
  candidatesSeen: string[][] = [];
  failVisible = false;

  async approves() { return this.approved; }
  async verifyEvent(workspace: {workspaceId: string; owner: GatekeeperSubject}, intent: AttentionIntent) {
    if (this.failEvents) throw new Error("InferOps unavailable");
    this.verified.push(intent.sourceEventId);
    this.verifiedAs.push(subjectAccountName(workspace.owner));
    let event = this.events.get(intent.sourceEventId);
    return event !== undefined && event.tenantId === intent.target.tenantId &&
      event.kind === intent.target.kind && event.id === intent.target.id &&
      event.type === REVIEW_EVENT_TYPE && intent.reason === "review_requested" &&
      event.workspaceId === intent.audience.workspaceId;
  }
  async eligible(_intent: AttentionIntent, candidates: GatekeeperSubject[]) {
    this.candidatesSeen.push(candidates.map(subjectAccountName));
    return [...candidates.filter(c => this.holders.has(subjectAccountName(c))),
      subject("outsider-not-a-member")];  // returned by the authority, never a member: dropped
  }
  async visible(who: GatekeeperSubject, targets: AttentionTarget[]) {
    if (this.failVisible) throw new Error("InferOps unavailable");
    return targets.map(t => !this.hidden.has(`${subjectAccountName(who)}|${t.id}`));
  }
  labels = new Map<string, unknown>();   // target id → what describe answers
  failDescribe = false;
  describedAs: string[] = [];
  async describe(who: GatekeeperSubject, targets: AttentionTarget[]) {
    if (this.failDescribe) throw new Error("InferOps unavailable");
    this.describedAs.push(subjectAccountName(who));
    return targets.map(t => this.hidden.has(`${subjectAccountName(who)}|${t.id}`)
      ? null : (this.labels.get(t.id) ?? null)) as (string | null)[];
  }
  openUrl: unknown = "https://work.example.test/r/project/location/x";
  failOpen = false;
  openedAs: {who: string; target: AttentionTarget}[] = [];
  async open(who: GatekeeperSubject, target: AttentionTarget) {
    if (this.failOpen) throw new Error("InferOps unavailable");
    this.openedAs.push({who: subjectAccountName(who), target});
    if (this.hidden.has(`${subjectAccountName(who)}|${target.id}`)) return null;
    return {url: this.openUrl as string};
  }
}

const withImpl = <T>(stub: DurableObjectStub<OverseerDurableObject>, fn: (impl: Impl) => Promise<T>) =>
  runInDurableObject(env.TEST_OVERSEER.get(stub.id), instance => fn(instance.impl));

/** A workspace owned by an InferLab person, with gadgets 100 and 101, one build and one use collaborator. */
async function setup(authority: FakeAuthority) {
  let run = crypto.randomUUID();
  let ownerName = subjectAccountName(subject(`owner-${run}`));
  let builderName = subjectAccountName(subject(`builder-${run}`));
  let viewerName = subjectAccountName(subject(`viewer-${run}`));
  let owner = env.TEST_USER.getByName(ownerName);
  let builder = env.TEST_USER.getByName(builderName);
  let viewer = env.TEST_USER.getByName(viewerName);
  for (let [stub, name] of [[owner, ownerName], [builder, builderName], [viewer, viewerName]] as const) {
    await runInDurableObject(stub, (_i, ctx) =>
      makeUserStorage(ctx.storage).profile.put({type: "user", id: name, name}));
  }
  let workspace = env.TEST_OVERSEER.getByName(run);
  let workspaceId = workspace.id.toString();
  await owner.newWorkspace(workspaceId, "Workspace");
  let ownerProfile = {type: "user" as const, id: ownerName, name: "Owner"};
  await withImpl(workspace, async impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.ownerId.put(owner.id.toString());
    impl.ownerId = owner.id.toString();
    impl.ownerProfileId = ownerName;
    for (let id of [100, 101]) {
      impl.storage.gadgets.put({type: "gadget", id, title: `App ${id}`, created: new Date(0),
        bindingName: `APP${id}`, bindings: {}});
    }
    impl.storage.gadgets.put({type: "gadget", id: 102, title: "Draft", created: new Date(0),
      bindingName: "DRAFT", bindings: {}, pending: {chatId: 1}});
    impl.storage.collaborators.put({profile: {type: "user", id: builderName, name: "Builder"},
      addedBy: [{type: "user", sharer: ownerName, role: "build", created: new Date()}]});
    impl.storage.collaborators.put({profile: {type: "user", id: viewerName, name: "Viewer"},
      addedBy: [{type: "user", sharer: ownerName, role: "use", gadgetId: 100, created: new Date()}]});
  });
  await builder.recordSharedWorkspaceOpen(workspaceId, "Workspace", ownerProfile, "build", []);
  await viewer.recordSharedWorkspaceOpen(workspaceId, "Workspace", ownerProfile, "use", []);
  authority.holders = new Set([ownerName, builderName, viewerName]);
  return {workspace, workspaceId, owner, builder, viewer, ownerName, builderName, viewerName};
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/** Raise `intent` from `caller`, as the gadget's env.ATTENTION would. */
const raise = (fixture: Fixture, authority: FakeAuthority, intent: unknown,
    caller: unknown = {from: "gadget", gadgetId: 100}) =>
  withImpl(fixture.workspace, async impl => {
    impl.attentionAuthority = () => authority;
    let attention = await impl.startGatekeeperSession({type: "attention"}, caller as never);
    await attention.raise(intent as AttentionIntent);
  });

const read = (user: DurableObjectStub<UserDurableObject>, authority: AttentionAuthority | null) =>
  runInDurableObject(user, (instance: UserDurableObject) => {
    instance.attentionAuthority = () => authority;
    return instance.getAttentionItems();
  });

const stored = (user: DurableObjectStub<UserDurableObject>) =>
  runInDurableObject(user, (_i, ctx) => [...makeUserStorage(ctx.storage).attentionItems.list()]);

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return String((err as Error).message);
  }
  return "(resolved)";
};

describe("env.ATTENTION: no unrestricted notify(user, url)", () => {
  it("is in a gadget's env, and not in the agent's", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    await withImpl(fixture.workspace, async impl => {
      impl.makeBindingLoopback = ((target: unknown) => target) as never;
      let gadgetEnv = impl.getEnvForLoader(100, {from: "gadget", gadgetId: 100}) as Record<string, unknown>;
      expect(gadgetEnv[ATTENTION_BINDING_NAME]).toEqual({type: "attention"});
      let agentEnv = impl.getEnvForAgent(1, {}, "exec-1") as Record<string, unknown>;
      expect(agentEnv[ATTENTION_BINDING_NAME]).toBeUndefined();
      // Like env.GIT, an existing binding of the same name still wins.
      impl.storage.gatekeepers.put({id: 1, resourceTitle: "Conn", class: {} as never});
      impl.storage.gadgets.put({type: "gadget", id: 103, title: "Legacy", created: new Date(0),
        bindingName: "LEGACY", bindings: {ATTENTION: {target: 1}}});
      let legacyEnv = impl.getEnvForLoader(103, {from: "gadget", gadgetId: 103}) as Record<string, unknown>;
      expect(legacyEnv[ATTENTION_BINDING_NAME]).toEqual({type: "gatekeeper", id: 1});
    });
  });

  it("refuses the agent, a user, a chat's proposed code, a pending gadget and an unknown one", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    for (let caller of [
      {from: "agent", chatId: 1},
      {from: "user"},
      {from: "gadget", gadgetId: 100, chatId: 1},
      {from: "gadget", gadgetId: 102},
      {from: "gadget", gadgetId: 999},
      {from: "gadget"},
    ]) {
      expect(await refusal(raise(fixture, authority, INTENT, caller)), JSON.stringify(caller))
        .toBe("Attention is only available to an accepted gadget's own code.");
    }
    expect(await stored(fixture.owner)).toEqual([]);
  });

  it("refuses a recipient list, a URL, a preview, a named-people audience and a URL target", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    let bad: Record<string, unknown>[] = [
      {...INTENT, recipients: [subject("someone")]},
      {...INTENT, url: "https://work.example.test/r/1"},
      {...INTENT, preview: "Main yard needs review"},
      {...INTENT, target: {...INTENT.target, url: "https://work.example.test/r/1"}},
      {...INTENT, audience: {...INTENT.audience, subjects: [subject("someone")]}},
      ...intentFixtures.invalid.map(f => f.value as Record<string, unknown>),
    ];
    let byParser = 0;
    for (let intent of bad) {
      let message = await refusal(raise(fixture, authority, intent));
      // A key the contract doesn't name gets past the RPC type check (capnweb-validate) and is
      // refused by the strict parser; a value of the wrong type is refused by the type check.
      expect(message, JSON.stringify(intent))
          .toMatch(/^(Attention intent refused: |capnweb-validate: at AttentionImpl\.raise)/);
      // The refusal names fields, never the refused values.
      expect(message).not.toContain("https://");
      expect(message).not.toContain("Main yard");
      expect(message).not.toContain("00000000-0000-4000-8000-000000000102");
      if (message.startsWith("Attention intent refused: ")) byParser++;
    }
    // Every extra-key case (recipients, url, preview, target url, audience subjects) is the parser's.
    expect(byParser).toBeGreaterThanOrEqual(5);
    expect(await stored(fixture.owner)).toEqual([]);
    expect(await stored(fixture.builder)).toEqual([]);
  });

  it("refuses without an authority, and for a target or workspace the authority doesn't approve", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    expect(await refusal(withImpl(fixture.workspace, async impl => {
      impl.attentionAuthority = () => null;
      let attention = await impl.startGatekeeperSession({type: "attention"}, {from: "gadget", gadgetId: 100});
      await attention.raise(INTENT);
    }))).toBe("Attention is unavailable: this deployment has no attention authority.");
    authority.approved = false;
    expect(await refusal(raise(fixture, authority, INTENT)))
      .toBe("Attention refused: this workspace may not raise attention for that target.");
    expect(await stored(fixture.owner)).toEqual([]);
  });

  it("refuses a workspace whose owner has no InferLab identity", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    await withImpl(fixture.workspace, async impl => { impl.ownerProfileId = "owner@example.com"; });
    expect(await refusal(raise(fixture, authority, INTENT)))
      .toBe("Attention is unavailable: this workspace's owner has no InferLab identity.");
  });
});

describe("every item stands for a real committed event (r2, round 1)", () => {
  it("refuses an invented event id, and offers nobody", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    for (let i = 0; i < 5; i++) {
      let invented = {...INTENT, sourceEventId: crypto.randomUUID()};
      expect(await refusal(raise(fixture, authority, invented)))
        .toBe("Attention refused: no committed event matches that intent.");
    }
    expect(authority.candidatesSeen).toEqual([]);
    expect(await stored(fixture.owner)).toEqual([]);
    expect(await stored(fixture.builder)).toEqual([]);
  });

  it("refuses a real event id raised for another target, type or workspace", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    let real = eventOf(INTENT);
    let cases: [string, FakeEvent][] = [
      ["another tenant", {...real, tenantId: "00000000-0000-4000-8000-0000000000a1"}],
      ["another kind", {...real, kind: "project/project"}],
      ["another record", {...real, id: "00000000-0000-4000-8000-0000000002b2"}],
      ["another event type", {...real, type: "project.issue.transitioned"}],
      ["another workspace", {...real, workspaceId: "00000000-0000-4000-8000-000000000012"}],
    ];
    for (let [why, event] of cases) {
      authority.events.set(INTENT.sourceEventId, event);
      expect(await refusal(raise(fixture, authority, INTENT)), why)
        .toBe("Attention refused: no committed event matches that intent.");
    }
    expect(await stored(fixture.owner)).toEqual([]);
  });

  it("keeps a real event replayed many times, by any gadget, to one item per recipient", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    for (let i = 0; i < 6; i++) {
      await raise(fixture, authority, INTENT, {from: "gadget", gadgetId: i % 2 === 0 ? 100 : 101});
    }
    expect(authority.verified).toHaveLength(6);
    // Verified with the workspace owner's rights, every time.
    expect(new Set(authority.verifiedAs)).toEqual(new Set([fixture.ownerName]));
    expect(await stored(fixture.owner)).toHaveLength(1);
    expect(await stored(fixture.builder)).toHaveLength(1);
  });

  it("refuses visibly when the authority can't tell", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    authority.failEvents = true;
    expect(await refusal(raise(fixture, authority, INTENT))).toBe("InferOps unavailable");
    expect(await stored(fixture.owner)).toEqual([]);
  });
});

describe("recipients are resolved server-side", () => {
  it("offers the authority only the owner and build collaborators, and keeps only members it returns", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    authority.holders = new Set([fixture.ownerName, fixture.builderName]);
    await raise(fixture, authority, INTENT);
    expect(authority.candidatesSeen).toEqual([[fixture.ownerName, fixture.builderName]]);
    let [ownerItem] = await stored(fixture.owner);
    expect(ownerItem).toMatchObject({itemKey: attentionItemKey(accountSubject(fixture.ownerName)!, INTENT),
      recipient: accountSubject(fixture.ownerName), personal: "unread", workspaceIds: [fixture.workspaceId]});
    expect(await stored(fixture.builder)).toHaveLength(1);
    // A use collaborator isn't offered, and the authority's non-member is dropped.
    expect(await stored(fixture.viewer)).toEqual([]);
    expect(await stored(env.TEST_USER.getByName(subjectAccountName(subject("outsider-not-a-member")))))
      .toEqual([]);
  });

  it("gives no item to a member outside the audience", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    authority.holders = new Set([fixture.ownerName]);
    await raise(fixture, authority, INTENT);
    expect(await stored(fixture.owner)).toHaveLength(1);
    expect(await stored(fixture.builder)).toEqual([]);
  });
});

describe("one semantic item per recipient", () => {
  it("two gadgets raising the same event, and a repeat, give one item each, and keep its read state", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    await raise(fixture, authority, INTENT, {from: "gadget", gadgetId: 100});
    let [first] = await read(fixture.owner, authority);
    await fixture.owner.setAttentionState(first!.itemKey, "read");
    await raise(fixture, authority, INTENT, {from: "gadget", gadgetId: 101});
    await raise(fixture, authority, INTENT, {from: "hook", gadgetId: 100});
    let items = await read(fixture.owner, authority);
    expect(items).toEqual([{...first, personal: "read"}]);
    expect(await read(fixture.builder, authority)).toHaveLength(1);
    // Another reason or event is another item.
    await raise(fixture, authority, {...INTENT, sourceEventId: LATER_EVENT});
    expect(await read(fixture.owner, authority)).toHaveLength(2);
  });

  it("keys items exactly as InferOps' attentionItemKey does", () => {
    for (let {value} of itemFixtures.valid) {
      expect(attentionItemKey(value.recipient, value as never)).toBe(value.itemKey);
      expect(accountSubject(subjectAccountName(value.recipient))).toEqual(value.recipient);
    }
    expect(accountSubject("owner@example.com")).toBeUndefined();
    expect(accountSubject("subject~not-an-origin~x")).toBeUndefined();
  });
});

describe("the projection: private, current and durable", () => {
  it("holds contract fields only: a reference and a reason, never a preview", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    await raise(fixture, authority, INTENT);
    let [item] = await read(fixture.owner, authority);
    expect(Object.keys(item!).toSorted()).toEqual(
      ["createdAt", "itemKey", "personal", "reason", "recipient", "sourceEventId", "target", "v"]);
    expect(item!.target).toEqual(INTENT.target);
  });

  it("hides an item from a recipient who lost access between raise and read", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    await raise(fixture, authority, INTENT);
    authority.hidden.add(`${fixture.builderName}|${INTENT.target.id}`);
    expect(await read(fixture.builder, authority)).toEqual([]);
    expect(await read(fixture.owner, authority)).toHaveLength(1);
    // Access restored: the stored item shows again, with its state.
    authority.hidden.clear();
    expect(await read(fixture.builder, authority)).toHaveLength(1);
  });

  it("returns nothing without an authority, and fails visibly when it can't tell", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    await raise(fixture, authority, INTENT);
    expect(await read(fixture.owner, null)).toEqual([]);
    authority.failVisible = true;
    expect(await refusal(read(fixture.owner, authority))).toBe("InferOps unavailable");
  });

  it("keeps the inbox and its read state across a restart", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    await raise(fixture, authority, INTENT);
    let [item] = await read(fixture.owner, authority);
    await fixture.owner.setAttentionState(item!.itemKey, "dismissed");
    await evictDurableObject(fixture.owner);
    expect(await read(fixture.owner, authority)).toEqual([{...item, personal: "dismissed"}]);
    await evictDurableObject(fixture.owner);
    await fixture.owner.setAttentionState(item!.itemKey, "read");
    await fixture.owner.setAttentionState("no-such-key", "read");
    await evictDurableObject(fixture.owner);
    expect(await read(fixture.owner, authority)).toEqual([{...item, personal: "read"}]);
  });

  it("refuses an item addressed to someone else", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    let [some] = itemFixtures.valid.map(f => f.value as AttentionItem);
    expect(await refusal(fixture.owner.attentionRaised(fixture.workspaceId, some!)))
      .toBe("Attention item is not addressed to this user.");
  });

  it("drops a workspace's items when it is removed, keeping items another workspace also raised", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    await raise(fixture, authority, INTENT);
    let [{workspaceIds: _, ...item}] = await stored(fixture.owner) as [AttentionItem & {workspaceIds: string[]}];
    let other = crypto.randomUUID();
    await fixture.owner.newWorkspace(other, "Other");
    await fixture.owner.attentionRaised(other, item);
    let later = "6f1c2a8e-4b1d-4c55-9a3e-2f6d8b1e0a03";
    await fixture.owner.attentionRaised(fixture.workspaceId,
        {...item, sourceEventId: later, itemKey: attentionItemKey(item.recipient, {...INTENT, sourceEventId: later})});
    await fixture.owner.deleteWorkspace(fixture.workspaceId);
    let left = await stored(fixture.owner);
    expect(left.map(r => [r.itemKey, r.workspaceIds])).toEqual([[item.itemKey, [other]]]);
  });
});

describe("the strict intent parser", () => {
  it("accepts the contract's valid intents and refuses its invalid ones", () => {
    for (let {value} of intentFixtures.valid) expect(parseAttentionIntent(value)).toEqual(value);
    for (let {value} of intentFixtures.invalid) expect(() => parseAttentionIntent(value)).toThrow();
  });
});

describe("labels and opening (FAC-238)", () => {
  const WORK = new Set(["https://work.example.test"]);
  const describeItems = (user: DurableObjectStub<UserDurableObject>, authority: AttentionAuthority | null,
      keys: string[]) =>
    runInDurableObject(user, (instance: UserDurableObject) => {
      instance.attentionAuthority = () => authority;
      return instance.describeAttentionItems(keys);
    });
  const open = (user: DurableObjectStub<UserDurableObject>, authority: AttentionAuthority | null,
      key: string, origins: Set<string> = WORK) =>
    runInDurableObject(user, (instance: UserDurableObject) => {
      instance.attentionAuthority = () => authority;
      instance.inferWorkOrigins = () => origins;
      return instance.openAttentionItem(key);
    });

  it("labels each of the person's own items with their own rights, null when gone, unknown or hidden", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    await raise(fixture, authority, INTENT);
    let [item] = await read(fixture.owner, authority);
    authority.labels.set(INTENT.target.id, "  Main\tyard\n(north)  ");
    expect(await describeItems(fixture.owner, authority, [item!.itemKey, "not-a-key"]))
      .toEqual(["Main yard (north)", null]);
    expect(authority.describedAs).toEqual([fixture.ownerName]);
    authority.labels.set(INTENT.target.id, "x".repeat(500));
    expect((await describeItems(fixture.owner, authority, [item!.itemKey]))[0]).toHaveLength(MAX_ATTENTION_LABEL);
    authority.labels.set(INTENT.target.id, 42);
    expect(await describeItems(fixture.owner, authority, [item!.itemKey])).toEqual([null]);
    authority.hidden.add(`${fixture.ownerName}|${INTENT.target.id}`);
    expect(await describeItems(fixture.owner, authority, [item!.itemKey])).toEqual([null]);
    // Another person's key names nothing in this person's list.
    expect(await describeItems(fixture.viewer, authority, [item!.itemKey])).toEqual([null]);
    // Without an authority: nothing to label. When it can't tell: a failure, never "gone".
    expect(await describeItems(fixture.owner, null, [item!.itemKey])).toEqual([null]);
    authority.failDescribe = true;
    expect(await refusal(describeItems(fixture.owner, authority, [item!.itemKey]))).toBe("InferOps unavailable");
    expect(await refusal(describeItems(fixture.owner, authority, Array(101).fill("k"))))
      .toBe("At most 100 attention items can be described at once.");
  });

  it("rejects an answer with the wrong number of labels rather than calling a record gone", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    await raise(fixture, authority, INTENT);
    let [item] = await read(fixture.owner, authority);
    for (let answer of [[] as string[], ["One", "Two"]]) {
      authority.describe = async () => answer;
      expect(await refusal(describeItems(fixture.owner, authority, [item!.itemKey])), JSON.stringify(answer))
        .toBe("InferLab answered for a different number of attention items than were asked about.");
    }
    // Two items asked about, one answered: shorter.
    authority.describe = async () => ["Only one"];
    expect(await refusal(describeItems(fixture.owner, authority, [item!.itemKey, item!.itemKey])))
      .toBe("InferLab answered for a different number of attention items than were asked about.");
  });

  it("opens only a validated InferWork link, resolved with the person's own rights for their own item", async () => {
    let authority = new FakeAuthority();
    let fixture = await setup(authority);
    await raise(fixture, authority, INTENT);
    let [item] = await read(fixture.owner, authority);
    expect(await open(fixture.owner, authority, item!.itemKey))
      .toEqual({url: "https://work.example.test/r/project/location/x"});
    expect(authority.openedAs).toEqual([{who: fixture.ownerName, target: INTENT.target}]);
    // Opening changes nothing about the item's personal state, nor anything in InferLab.
    expect((await stored(fixture.owner))[0]?.personal).toBe("unread");

    // Only an http(s) link with no user info, on a configured InferWork origin exactly.
    for (let bad of ["https://evil.example/r/x", "https://work.example.test.evil.example/x",
        "http://work.example.test/x", "https://user:pw@work.example.test/x", "javascript:alert(1)",
        "data:text/html,x", "//work.example.test/x", "/r/x", 42, ""]) {
      authority.openUrl = bad;
      expect(await refusal(open(fixture.owner, authority, item!.itemKey)), String(bad))
        .toBe("InferLab offered a link this deployment doesn't open.");
    }
    authority.openUrl = "https://work.example.test/r/project/location/x";
    expect(await refusal(open(fixture.owner, authority, item!.itemKey, new Set())))
      .toBe("InferLab offered a link this deployment doesn't open.");

    // Not the person's item; not visible now; no authority; indeterminate.
    expect(await refusal(open(fixture.viewer, authority, item!.itemKey))).toBe("That attention item isn't in your list.");
    authority.hidden.add(`${fixture.ownerName}|${INTENT.target.id}`);
    expect(await refusal(open(fixture.owner, authority, item!.itemKey))).toBe("You can't open this now.");
    expect(await refusal(open(fixture.owner, null, item!.itemKey))).toBe("Attention is unavailable on this deployment.");
    authority.hidden.clear();
    authority.failOpen = true;
    expect(await refusal(open(fixture.owner, authority, item!.itemKey))).toBe("InferOps unavailable");
  });

  it("reads INFERWORK_ORIGINS as bare http(s) origins only", () => {
    expect([...inferWorkOriginsFrom({INFERWORK_ORIGINS: " https://work.example.test , http://localhost:19804,https://x.example/path,ftp://f.example,nonsense"})])
      .toEqual(["https://work.example.test", "http://localhost:19804"]);
    expect(inferWorkOriginsFrom({}).size).toBe(0);
    expect(acceptedInferWorkUrl("http://localhost:19804/r/x", inferWorkOriginsFrom({INFERWORK_ORIGINS: "http://localhost:19804"})))
      .toBe("http://localhost:19804/r/x");
    expect(cleanAttentionLabel("\u0000\u0007 ")).toBeNull();
  });
});
