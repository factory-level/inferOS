// Test worker: the production entrypoints, plus a fake Workshop callback, a fake approval queue and
// the hooks a test drives the connection through. Under the capnweb-validate vite plugin, decorated
// WorkerEntrypoint exports are not registered in `ctx.exports` (see gatekeeper-inferlab's test
// worker), so the entrypoints are re-exported as undecorated subclasses with the same behaviour.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, ConnectHandoff, GatekeeperConnectCallback, GatekeeperSubject,
  GatekeeperUser, GatekeeperUserVerifier, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  GatekeeperVendor as RealVendor, InferLabAttentionAuthority as RealAttention,
  OperationsUser as RealUser, OperationsVerifier as RealVerifier, type ProjectGatekeeper,
} from "../src/worker.js";
import { subjectIndexName } from "../src/account.js";

export { default } from "../src/worker.js";
export { ConnectAttempt, OperationsAccount, ProjectGatekeeper, SubjectIndex } from "../src/worker.js";

export class GatekeeperVendor extends RealVendor {}
export class OperationsUser extends RealUser {}
export class OperationsVerifier extends RealVerifier {}
export class InferLabAttentionAuthority extends RealAttention {}

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
  constructor(readonly log: QueueLog) {
    super();
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

  async revoke(label: string): Promise<void> {
    await (await this.#account(label)).revoke();
  }

  /** The attention authority, as the Workshop's ATTENTION_AUTHORITY binding reaches it. */
  async attention(method: "approves" | "eligible" | "visible", ...args: unknown[]): Promise<unknown> {
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
}
