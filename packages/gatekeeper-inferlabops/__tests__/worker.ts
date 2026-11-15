// Test worker: the production entrypoints, plus a fake Workshop callback, a fake approval queue and
// the hooks a test drives the connection through. Under the capnweb-validate vite plugin, decorated
// WorkerEntrypoint exports are not registered in `ctx.exports` (see gatekeeper-inferlab's test
// worker), so the entrypoints are re-exported as undecorated subclasses with the same behaviour.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, ConnectHandoff, GatekeeperConnectCallback, GatekeeperSubject,
  GatekeeperUser, GatekeeperUserVerifier, HookController, HookDescription, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  GatekeeperVendor as RealVendor, InferLabAttentionAuthority as RealAttention,
  OperationsUser as RealUser, OperationsVerifier as RealVerifier, ProjectGatekeeper,
  ProjectEventHookController as RealEventController,
} from "../src/worker.js";
import type { StoredEvent } from "../src/events.js";
import type { ProjectEvent } from "../src/types.js";
import { subjectIndexName } from "../src/account.js";

export { default } from "../src/worker.js";
export { ConnectAttempt, OperationsAccount, ProjectEventDriver, ProjectGatekeeper, SubjectIndex } from "../src/worker.js";

export class GatekeeperVendor extends RealVendor {}
export class OperationsUser extends RealUser {}
export class OperationsVerifier extends RealVerifier {}
export class InferLabAttentionAuthority extends RealAttention {}
export class ProjectEventHookController extends RealEventController {}

/** The accounts the fake Workshop received, by attempt label: their account ids. */
const received = new Map<string, string>();

export class FakeCallback extends WorkerEntrypoint<Cloudflare.Env, { label: string }>
    implements Pick<GatekeeperConnectCallback, "complete" | "credentialsExpired"> {
  async complete(account: Fetcher<GatekeeperUser>): Promise<ConnectHandoff> {
    // The account id is the user entrypoint's only prop; the test reaches it through describe().
    const subject = await (account as unknown as Fetcher<RealUser>).getAuthenticatedSubject();
    received.set(this.ctx.props.label, JSON.stringify(subject));
    return { targetOrigin: "http://localhost:8787", ticket: "t".repeat(64) };
  }

  async credentialsExpired(): Promise<void> {
    expired.push(this.ctx.props.label);
  }
}

const expired: string[] = [];

/** What the fake approval queue saw. */
export type QueueLog = {
  observations: (ObservationDescription & { subresources?: string[] })[];
  actions: { id: number; description: ActionDescription }[];
};

class FakeQueue extends RpcTarget {
  constructor(readonly log: QueueLog, readonly storage?: DurableObjectStorage) {
    super();
  }

  /** As the Workshop's: keeps the controller; the hook stays disabled until a test enables it. */
  async bindHook(controller: unknown, _callback: unknown, description: HookDescription): Promise<void> {
    if (!this.storage) throw new Error("this queue binds no hooks");
    this.storage.kv.put("hookController", controller);
    this.storage.kv.put("hookDescription", description);
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.log.observations.push(description);
  }

  async submitAction(id: number, description: ActionDescription): Promise<void> {
    this.log.actions.push({ id, description });
  }
}

/** A verifier answering as one connected account's real OperationsVerifier would. */
type TestExports = {
  FakeCallback(options: { props: { label: string } }): Fetcher<FakeCallback>;
  ProjectGatekeeper(options: { props: unknown }): DurableObjectClass<ProjectGatekeeper>;
  OperationsVerifier(options: { props: { accountId: string } }): Fetcher<GatekeeperUserVerifier>;
  OperationsUser(options: { props: { accountId: string } }): Fetcher<GatekeeperUser>;
};

const sessions = new Map<string, { session: unknown; log: QueueLog }>();

export class TestHooks extends DurableObject<Cloudflare.Env> {
  get #exports(): TestExports {
    return this.ctx.exports as unknown as TestExports;
  }

  /**
   * A received account, as the Workshop would hold it, built in this object's own context (a stub
   * from another Durable Object can't be used here). Found by the person's subject.
   */
  async #account(label: string): Promise<Fetcher<GatekeeperUser>> {
    return this.#exports.OperationsUser({ props: { accountId: await this.#accountId(label) } });
  }

  async #accountId(label: string): Promise<string> {
    const raw = received.get(label);
    if (!raw) throw new Error(`no account for ${label}`);
    const subject = JSON.parse(raw) as GatekeeperSubject;
    const index = this.ctx.exports.SubjectIndex.get(this.ctx.exports.SubjectIndex.idFromName(subjectIndexName(subject)));
    const accountId = await index.account();
    if (!accountId) throw new Error(`no connection for ${label}`);
    return accountId;
  }

  /** The vendor's connectAccount with a real callback stub; the error message, or "started". */
  async vendorConnect(scopes: "auth" | "full" | undefined): Promise<string> {
    const vendor = new GatekeeperVendor(this.ctx as unknown as ExecutionContext, this.env);
    const callback = this.#exports.FakeCallback({ props: { label: "vendor" } });
    try {
      await vendor.connectAccount(callback as unknown as Fetcher<GatekeeperConnectCallback>, scopes ? { scopes } as never : undefined);
      return "started";
    } catch (error) {
      return (error as Error).message;
    }
  }

  async startAttempt(attemptId: string, nonce: string, label: string): Promise<void> {
    const callback = this.#exports.FakeCallback({ props: { label } });
    const stub = this.env.CONNECT_ATTEMPT.get(this.env.CONNECT_ATTEMPT.idFromString(attemptId));
    await stub.start(callback as unknown as Fetcher<GatekeeperConnectCallback>, nonce);
  }

  async received(label: string): Promise<string | null> {
    return received.get(label) ?? null;
  }

  async expiredLabels(): Promise<string[]> {
    return [...expired];
  }

  /** getGatekeeperClassFor on a received account: the facet props it chose, or the error it threw. */
  async bind(label: string, url: string): Promise<{ props?: Record<string, string>; error?: string }> {
    const account = await this.#account(label);
    try {
      const { class: cls } = await account.getGatekeeperClassFor(url);
      const facet = this.ctx.facets.get<ProjectGatekeeper>(`gk-${label}-${url}`, () => ({ class: cls }));
      const description = await facet.describe();
      return { props: { url: description.url } };
    } catch (error) {
      return { error: `${(error as Error).name}: ${(error as Error).message}` };
    }
  }

  /** Opens a session on a bound Project and keeps it, with its queue log, under `key`. */
  async open(label: string, url: string, key: string): Promise<void> {
    const account = await this.#account(label);
    const { class: cls } = await account.getGatekeeperClassFor(url);
    const facet = this.ctx.facets.get<ProjectGatekeeper>(`gk-${key}`, () => ({ class: cls }));
    const log: QueueLog = { observations: [], actions: [] };
    const queue = new RpcStub(new FakeQueue(log)) as unknown as RpcStub<ApprovalQueue>;
    const session = await facet.startSession(queue as never);
    sessions.set(key, { session, log });
  }

  /** Calls one session method; returns its result or its error's name and message. */
  async call(key: string, method: string, ...args: unknown[]): Promise<{ value?: unknown; error?: string }> {
    const entry = sessions.get(key)!;
    try {
      // The session is an RPC stub: call the method on it, never Function.prototype.apply.
      const session = entry.session as Record<string, (...a: unknown[]) => Promise<unknown>>;
      return { value: await session[method]!(...args) };
    } catch (error) {
      return { error: `${(error as Error).name}: ${(error as Error).message}` };
    }
  }

  async log(key: string): Promise<QueueLog> {
    return sessions.get(key)!.log;
  }

  async apply(key: string, actionId: number): Promise<string | null> {
    const facet = this.ctx.facets.get<ProjectGatekeeper>(`gk-${key}`, () => { throw new Error("no facet"); });
    try {
      await facet.applyAction(actionId, undefined as never);
      return null;
    } catch (error) {
      return `${(error as Error).name}: ${(error as Error).message}`;
    }
  }

  async reject(key: string, actionId: number): Promise<void> {
    const facet = this.ctx.facets.get<ProjectGatekeeper>(`gk-${key}`, () => { throw new Error("no facet"); });
    await facet.rejectAction(actionId);
  }

  /**
   * verifyObserverAccess on `key`'s facet for observers given as received-account labels, each with
   * its own real verifier. Returns the admitted labels, or the thrown message.
   */
  async verify(key: string, observerLabels: string[], subresources: string[]): Promise<string[] | string> {
    const facet = this.ctx.facets.get<ProjectGatekeeper>(`gk-${key}`, () => { throw new Error("no facet"); });
    // Each observer's own verifier, built here as the user's getVerifier() builds it.
    const observers = await Promise.all(observerLabels.map(async label => ({
      id: label, verifier: this.#exports.OperationsVerifier({ props: { accountId: await this.#accountId(label) } }),
    })));
    try {
      return (await facet.verifyObserverAccess(observers, subresources)).allowedObserverIds;
    } catch (error) {
      return (error as Error).message;
    }
  }

  /**
   * verifyObserverAccess with each observer's verifier taken as the Workshop takes it: from that
   * person's own user entrypoint, `getVerifier()`, across RPC. Returns the admitted labels, or the
   * thrown message.
   */
  async verifyThroughUsers(key: string, observerLabels: string[], subresources: string[]): Promise<string[] | string> {
    const facet = this.ctx.facets.get<ProjectGatekeeper>(`gk-${key}`, () => { throw new Error("no facet"); });
    try {
      const observers = await Promise.all(observerLabels.map(async label => ({
        id: label,
        verifier: await this.#exports.OperationsUser({ props: { accountId: await this.#accountId(label) } }).getVerifier(),
      })));
      return (await facet.verifyObserverAccess(observers, subresources)).allowedObserverIds;
    } catch (error) {
      return (error as Error).message;
    }
  }

  async revoke(label: string): Promise<void> {
    await (await this.#account(label)).revoke();
  }

  /** The attention authority, as the Workshop's ATTENTION_AUTHORITY binding reaches it. */
  async attention(method: "approves" | "eligible" | "visible" | "verifyEvent" | "describe" | "open",
      ...args: unknown[]): Promise<unknown> {
    const authority = new InferLabAttentionAuthority(this.ctx as unknown as ExecutionContext, this.env);
    try {
      const call = authority as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      return await call[method]!(...args);
    } catch (error) {
      return { thrown: (error as Error).message };
    }
  }

  async subjectOf(label: string): Promise<GatekeeperSubject | null> {
    const raw = received.get(label);
    return raw ? JSON.parse(raw) as GatekeeperSubject : null;
  }

  // ── Hooks (FAC-236), with this object standing in for the Overseer ───────────────────────────
  //
  // One hook at a time: subscribing through a session stores the controller it binds; enabling
  // hands it an initiator whose firings reach `startHook()` here, delivering to a RecordingHook.

  #hook: HookState = { received: [], observations: [], refuse: false, failures: 0, slowMs: 0 };

  /** Subscribe through `key`'s session, with its facet's ctx.restore() routed back here. */
  async subscribe(key: string): Promise<{ description?: HookDescription; error?: string }> {
    const facet = this.ctx.facets.get<ProjectGatekeeper>(`gk-${key}`, () => { throw new Error("no facet"); });
    await (facet as unknown as HookFacet).testRestoreThrough(this.ctx.id.toString(), key);
    this.ctx.storage.kv.delete("hookController");
    using queue = new RpcStub(new FakeQueue({ observations: [], actions: [] }, this.ctx.storage));
    using session = await facet.startSession(queue as never) as unknown as { subscribe(h: unknown): Promise<void> } & Disposable;
    using hook = new RpcStub(new RecordingHook(this.#hook));
    try {
      await session.subscribe(hook);
      return { description: this.ctx.storage.kv.get<HookDescription>("hookDescription")! };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  async enableHook(): Promise<string | null> {
    const initiator = (this.ctx.exports as unknown as HookExports).TestHookInitiator({ props: { hooks: this.ctx.id.toString() } });
    try {
      await this.#controller().enable(initiator as never, { workspaceId: "test-workspace" });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }

  async disableHook(): Promise<void> {
    await this.#controller().disable();
  }

  /** The Overseer's startHook(): refused for a disabled or deleted hook, as the Workshop's is. */
  startHook() {
    if (this.#hook.refuse) throw new Error("Hook is disabled or was deleted.");
    if (this.#hook.failures > 0) {
      this.#hook.failures--;
      throw new Error("The test Workshop failed to start the firing.");
    }
    return { callback: new RecordingHook(this.#hook), approvalQueue: new RpcStub(new FiringQueue(this.#hook)) };
  }

  /** What a delivery stub the facet minted reaches: the facet's own `[restore]()` target. */
  async deliverHook(key: string, callback: RpcStub<RpcTarget>, approvalQueue: RpcStub<RpcTarget>,
                    event: StoredEvent): Promise<void> {
    const facet = this.ctx.facets.get<ProjectGatekeeper>(`gk-${key}`, () => { throw new Error("no facet"); });
    await (facet as unknown as HookFacet).testDeliver(callback, approvalQueue, event);
  }

  setHook(behavior: Partial<Pick<HookState, "refuse" | "failures" | "slowMs">>): void {
    Object.assign(this.#hook, behavior);
  }

  readHook(): Pick<HookState, "received" | "observations"> {
    return { received: this.#hook.received, observations: this.#hook.observations };
  }

  resetHook(): void {
    this.#hook.received.length = 0;
    this.#hook.observations.length = 0;
    this.#hook.refuse = false;
    this.#hook.failures = 0;
    this.#hook.slowMs = 0;
  }

  #controller(): HookController<RpcTarget> {
    const controller = this.ctx.storage.kv.get<HookController<RpcTarget>>("hookController");
    if (!controller) throw new Error("No hook has been bound.");
    return controller;
  }
}

/** What the test hook and its firings recorded. */
type HookState = {
  received: { eventId: string; type: string; workspaceId: string; location: string; locationProject: string;
    revision: string; projectRead: string }[];
  observations: { title: string; subresources?: string[] }[];
  /** Refuse every firing, as the Workshop does for a disabled or deleted hook. */
  refuse: boolean;
  /** Fail this many more firings, as a transient failure would. */
  failures: number;
  /** How long the hook takes to return. */
  slowMs: number;
};

type HookExports = {
  TestHooks: DurableObjectNamespace<TestHooks>;
  TestHookInitiator(options: { props: { hooks: string } }): Fetcher<TestHookInitiator>;
  TestHookDelivery(options: { props: { hooks: string; key: string } }): Fetcher<TestHookDelivery>;
};

const testHooks = (exports: Cloudflare.Exports, id: string) => {
  const namespace = (exports as unknown as HookExports).TestHooks;
  return namespace.get(namespace.idFromString(id));
};

/** The Overseer's HookInitiator: each firing reaches the TestHooks object that enabled the hook. */
export class TestHookInitiator extends WorkerEntrypoint<Cloudflare.Env, { hooks: string }> {
  startHook() {
    return testHooks(this.ctx.exports, this.ctx.props.hooks).startHook();
  }
}

/**
 * Stands in for the stub the facet mints with ctx.restore(), which this pool cannot do (its
 * Durable Object wrappers don't forward `[restore]`): it reaches the facet's real `[restore]`
 * target through TestHooks.
 */
export class TestHookDelivery extends WorkerEntrypoint<Cloudflare.Env, { hooks: string; key: string }> {
  deliver(callback: RpcStub<RpcTarget>, approvalQueue: RpcStub<RpcTarget>, event: StoredEvent) {
    return testHooks(this.ctx.exports, this.ctx.props.hooks).deliverHook(this.ctx.props.key, callback, approvalQueue, event);
  }
}

/** The approval queue of every firing: records what the deliveries observed. */
class FiringQueue extends RpcTarget {
  constructor(private readonly state: HookState) {
    super();
  }

  async authorizeObservation(observation: { title: string; subresources?: string[] }): Promise<void> {
    this.state.observations.push({ title: observation.title, subresources: observation.subresources });
  }

  async submitAction(): Promise<void> {}
}

/** A Gadget's hook: records each event, and reads the Project back through the session it was given. */
class RecordingHook extends RpcTarget {
  constructor(private readonly state: HookState) {
    super();
  }

  async receiveEvent(event: ProjectEvent): Promise<void> {
    if (this.state.slowMs > 0) await new Promise(resolve => setTimeout(resolve, this.state.slowMs));
    const project = await event.project.getProject();
    this.state.received.push({
      eventId: event.eventId, type: event.type, workspaceId: event.workspaceId, location: event.location.name,
      locationProject: event.location.project.id, revision: event.revision, projectRead: project.key,
    });
  }
}

type HookFacet = {
  testRestoreThrough(hooks: string, key: string): Promise<void>;
  testDeliver(callback: RpcStub<RpcTarget>, queue: RpcStub<RpcTarget>, event: StoredEvent): Promise<void>;
};
const facetPrototype = ProjectGatekeeper.prototype as unknown as HookFacet & { [restore](p: unknown): {
  deliver(c: unknown, q: unknown, e: unknown): Promise<void> } };

/** Make this facet's ctx.restore() mint TestHookDelivery stubs that route back to `[restore]`. */
facetPrototype.testRestoreThrough = async function(hooks, key) {
  const { ctx } = this as unknown as { ctx: DurableObjectState };
  const exports = ctx.exports as unknown as HookExports;
  (ctx as unknown as { restore: unknown }).restore = async () => Object.assign(
    exports.TestHookDelivery({ props: { hooks, key } }), { [Symbol.dispose]() {} });
};

/** Deliver through the target the facet's `[restore]()` returns for a hook's delivery stub. */
facetPrototype.testDeliver = function(callback, queue, event) {
  return (this as unknown as typeof facetPrototype)[restore]({ kind: "project-events" }).deliver(callback, queue, event);
};
