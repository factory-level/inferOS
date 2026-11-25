// A Workshop session's life (FAC-300): every session expires, a session a kept provider sign-in
// backs (a vendor that declares `keepsSignIn`, like InferLab) lives only while that sign-in does,
// and signing out ends the session, the sign-in behind it everywhere, and every other session a
// sign-in through the same provider backs, and closes every connection authenticated with one of
// them. Through the real login callback, user DO and API Worker, with a sign-in account that stands
// in for the InferLab gatekeeper's.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import {
  SIGN_OUT_ERROR_CODES, SIGN_OUT_ERROR_MESSAGES, getSignOutErrorCode, type AuthenticatedApi, type PublicApi,
} from "@gadgets/workshop-shared/api";
import server from "../src/server.js";
import type { LoginConnectCallbackImpl, PendingLogin } from "../src/auth/login-flow.js";
import type { UserDurableObject } from "../src/user.js";
import {
  SESSION_LIFETIME_MS, SIGN_IN_CHECK_INTERVAL_MS, SIGN_IN_RETRY_INTERVAL_MS, SIGN_IN_UNCONFIRMED_LIMIT_MS,
} from "../src/user.js";
import type { LoginSessionRecord, SignInBackingRecord } from "../src/storage-schema/user-storage.js";
import type { FakeKeptSignInAccount } from "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_PENDING_LOGIN: DurableObjectNamespace<PendingLogin>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type AccountProps = { key: string; issuer: string; subject: string; email: string };
type Exports = {
  FakeKeptSignInAccount(options: { props: AccountProps }): Fetcher<FakeKeptSignInAccount>;
  TestSubjectLoginCallback(options: {
    props: { pendingId: string; vendorId: string; subject?: boolean; keeps?: boolean };
  }): Fetcher<LoginConnectCallbackImpl>;
};
// What a test reaches into a user DO for.
type Internals = {
  sessionWatches: { counts: Map<string, number>; timer: unknown; intervalMs: number; requested: number };
  ctx: DurableObjectState & { exports: Exports };
  storage: {
    sessions: {
      list(): Iterable<LoginSessionRecord>; get(id: string): LoginSessionRecord | undefined;
      put(record: LoginSessionRecord): void;
    };
    signInBackings: {
      list(): Iterable<SignInBackingRecord>; delete(id: string): void;
      get(id: string): SignInBackingRecord | undefined;
    };
    connectedAccounts: { list(): Iterable<unknown> };
  };
};

// The issuer TestSubjectLoginCallback trusts for the vendor `inferlab`.
const ISSUER = "http://localhost:23380";
const fresh = () => crypto.randomUUID().slice(0, 8);
const internals = (instance: UserDurableObject) => instance as unknown as Internals;

/** One person, as InferLab would sign them in: a principal and the address it vouches for. */
function person() {
  const subject = fresh();
  return { subject, email: `ada-${subject}@example.test` };
}

/**
 * Signs `who` in through the real callback, for a vendor asked to keep its sign-in. `key` names the
 * sign-in account the gatekeeper hands over. Returns the account name, session secret and key.
 */
async function signIn(who: { subject: string; email: string }, key = fresh(), keeps = true)
    : Promise<{ name: string; secret: string; key: string }> {
  const pending = env.TEST_PENDING_LOGIN.getByName(`session-login-${fresh()}`);
  await pending.begin();
  let ticket = "";
  await runInDurableObject(env.TEST_USER.getByName(`host-${fresh()}`), async (instance: UserDurableObject) => {
    const exports = internals(instance).ctx.exports;
    const callback = exports.TestSubjectLoginCallback({
      props: { pendingId: pending.id.toString(), vendorId: "inferlab", subject: true, ...(keeps ? { keeps } : {}) },
    });
    const account = exports.FakeKeptSignInAccount({ props: { key, issuer: ISSUER, ...who } });
    ({ ticket } = await callback.complete(account as never));
  });
  await pending.confirm(ticket);
  const token = (await pending.receive())!;
  const split = token.lastIndexOf(":");
  return { name: token.slice(0, split), secret: token.slice(split + 1), key };
}

/** Runs `body` inside the user DO `name`. */
function inUser<R>(name: string, body: (internals: Internals, instance: UserDurableObject) => R | Promise<R>): Promise<R> {
  return runInDurableObject(env.TEST_USER.getByName(name),
    async (instance: UserDurableObject) => body(internals(instance), instance));
}

/** A sign-in account's recorded calls and controls, through a stub minted in a DO's exports. */
function onAccount(key: string, body: (stub: Fetcher<FakeKeptSignInAccount>) => Promise<unknown>): Promise<unknown> {
  return inUser(`host-${fresh()}`, ({ ctx }) =>
    body(ctx.exports.FakeKeptSignInAccount({ props: { key, issuer: ISSUER, subject: "", email: "" } })));
}
const callsOf = async (key: string) => await onAccount(key, stub => stub.calls()) as string[];
const answer = (key: string, value: "live" | "ended" | "down") => onAccount(key, stub => stub.setAnswer(value));
const hold = (key: string) => onAccount(key, stub => stub.hold());
const release = (key: string) => onAccount(key, stub => stub.release());

/** "accepted", or the refusal's message, caught on the call itself. */
const authenticate = (name: string, secret: string) =>
  env.TEST_USER.getByName(name).authenticate(secret).then(() => "accepted", (error: Error) => error.message);

const sessions = (name: string) => inUser(name, ({ storage }) => [...storage.sessions.list()]);
const backings = (name: string) => inUser(name, ({ storage }) => [...storage.signInBackings.list()]
  .map(({ id, vendorId }) => ({ id, vendorId })));

/** Moves every session's last confirmation of its backing sign-in `ageMs` into the past. */
const ageChecks = (name: string, ageMs: number) => inUser(name, ({ storage }) => {
  for (const session of Array.from(storage.sessions.list())) {
    if (session.backing) {
      storage.sessions.put({ ...session, backing: { ...session.backing, checkedAt: new Date(Date.now() - ageMs) } });
    }
  }
});

/** Moves every backed session's last failed check `ageMs` into the past. */
const ageFailures = (name: string, ageMs: number) => inUser(name, ({ storage }) => {
  for (const session of Array.from(storage.sessions.list())) {
    if (session.backing?.failedAt) {
      storage.sessions.put({ ...session, backing: { ...session.backing, failedAt: new Date(Date.now() - ageMs) } });
    }
  }
});

/** A session record as written before sessions expired (or with `expiresAt`), and its secret. */
const plantSession = (name: string, record: { created: Date; expiresAt?: Date }) => inUser(name, async ({ storage }) => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const tokenId = new Uint8Array(await crypto.subtle.digest("SHA-256", secret)).toHex();
  storage.sessions.put({ tokenId, ...record });
  return secret.toBase64();
});

/**
 * A WebSocket API session with the Worker. The first /api request installs the bundled blueprints,
 * which needs storage these tests lack, so AdminSettings reports it done.
 */
async function connect(): Promise<RpcStub<PublicApi>> {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "exports", { value: Object.create(ctx.exports, {
    AdminSettings: { value: { getByName: () => ({ ensureBundledBlueprintsInstalled: async () => true }) } },
  }) });
  const response = await server.fetch(new Request("https://workshop.example/api", {
    headers: { Upgrade: "websocket" },
  }), env as never, ctx);
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

/** "working" while a connection's API answers, or "refused" once it does not. */
const state = (api: { whoami(): Promise<unknown> }) => api.whoami().then(() => "working", () => "refused");

const DAY = 24 * 60 * 60 * 1000;

describe("a sign-in that keeps its provider sign-in (FAC-300)", () => {
  it("backs the session with the sign-in account, connecting nothing, and expires it in 30 days", async () => {
    const { name, secret, key } = await signIn(person());

    const [session] = await sessions(name);
    const [backing] = await backings(name);
    expect(session!.backing).toMatchObject({ id: backing!.id, vendorId: "inferlab" });
    expect(session!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + SESSION_LIFETIME_MS - 60_000);
    expect(await inUser(name, ({ storage }) => [...storage.connectedAccounts.list()])).toEqual([]);
    // Confirmed live by the sign-in itself: nothing is asked until the interval has passed.
    expect(await authenticate(name, secret)).toBe("accepted");
    expect(await callsOf(key)).toEqual([]);
  });

  it("gives each sign-in its own backing, so two browsers are two sessions", async () => {
    const who = person();
    const first = await signIn(who);
    const second = await signIn(who);
    expect(second.name).toBe(first.name);
    const ids = (await sessions(first.name)).map(s => s.backing?.id);
    expect(new Set(ids).size).toBe(2);
    expect(await authenticate(first.name, first.secret)).toBe("accepted");
    expect(await authenticate(second.name, second.secret)).toBe("accepted");
  });

  it("revokes the sign-in when it cannot mint a session, so its provider session is not left behind", async () => {
    const key = fresh();
    const pending = env.TEST_PENDING_LOGIN.getByName(`session-login-${fresh()}`);
    await pending.begin();
    await runInDurableObject(env.TEST_USER.getByName(`host-${fresh()}`), async (instance: UserDurableObject) => {
      const exports = internals(instance).ctx.exports;
      const callback = exports.TestSubjectLoginCallback({
        props: { pendingId: pending.id.toString(), vendorId: "inferlab", subject: true, keeps: true },
      });
      // An issuer the deployment doesn't trust: the sign-in fails before any session is minted.
      const untrusted = exports.FakeKeptSignInAccount({
        props: { key, issuer: "https://other.example.test", ...person() },
      });
      await callback.complete(untrusted as never);
    });
    expect(await callsOf(key)).toEqual(["revoke"]);
  });

  it("backs nothing when the vendor was not asked to keep its sign-in", async () => {
    const { name, key } = await signIn(person(), fresh(), false);
    const [session] = await sessions(name);
    expect(session!.backing).toBeUndefined();
    expect(await backings(name)).toEqual([]);
    expect(await callsOf(key)).toEqual([]);
  });
});

describe("a session a sign-in backs", () => {
  it("asks the sign-in at most every five minutes, and renews the session while it is live", async () => {
    const { name, secret, key } = await signIn(person());
    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS + 1000);
    await inUser(name, ({ storage }) => {
      const [session] = [...storage.sessions.list()];
      storage.sessions.put({ ...session!, expiresAt: new Date(Date.now() + DAY) });
    });

    expect(await authenticate(name, secret)).toBe("accepted");
    expect(await callsOf(key)).toEqual(["checkSignIn"]);
    const [renewed] = await sessions(name);
    expect(renewed!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + SESSION_LIFETIME_MS - 60_000);

    expect(await authenticate(name, secret)).toBe("accepted");
    expect(await callsOf(key)).toEqual(["checkSignIn"]);
  });

  it("ends once the sign-in has ended anywhere, forgetting its account", async () => {
    const { name, secret, key } = await signIn(person());
    await answer(key, "ended");
    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS);

    expect(await authenticate(name, secret)).toBe("invalid session token");
    expect(await sessions(name)).toEqual([]);
    expect(await backings(name)).toEqual([]);
    expect(await authenticate(name, secret)).toBe("invalid session token");
    expect(await callsOf(key)).toEqual(["checkSignIn"]);
  });

  it("stands when InferLab cannot answer, and asks again no sooner than a minute later", async () => {
    const { name, secret, key } = await signIn(person());
    await answer(key, "down");
    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS);

    expect(await authenticate(name, secret)).toBe("accepted");
    expect(await authenticate(name, secret)).toBe("accepted");
    expect(await callsOf(key)).toEqual(["checkSignIn"]);

    await ageFailures(name, SIGN_IN_RETRY_INTERVAL_MS);
    expect(await authenticate(name, secret)).toBe("accepted");
    expect(await callsOf(key)).toEqual(["checkSignIn", "checkSignIn"]);

    // Answering again ends the back-off.
    await answer(key, "live");
    await ageFailures(name, SIGN_IN_RETRY_INTERVAL_MS);
    expect(await authenticate(name, secret)).toBe("accepted");
    expect((await sessions(name))[0]!.backing!.failedAt).toBeUndefined();
  });

  it("fails closed once a day has passed without the sign-in confirmed live", async () => {
    const { name, secret, key } = await signIn(person());
    await answer(key, "down");
    await ageChecks(name, SIGN_IN_UNCONFIRMED_LIMIT_MS - 60_000);
    expect(await authenticate(name, secret)).toBe("accepted");

    // Inside the back-off too: an unanswered day ends the session without asking again.
    await ageChecks(name, SIGN_IN_UNCONFIRMED_LIMIT_MS);
    expect(await authenticate(name, secret)).toBe("invalid session token");
    expect(await callsOf(key)).toEqual(["checkSignIn"]);
    expect(await sessions(name)).toEqual([]);
  });

  it("never lets an answer about one sign-in end another sign-in's session", async () => {
    const who = person();
    const first = await signIn(who);
    const second = await signIn(who);
    await answer(first.key, "ended");
    await ageChecks(first.name, SIGN_IN_CHECK_INTERVAL_MS);

    expect(await authenticate(first.name, first.secret)).toBe("invalid session token");
    expect(await authenticate(second.name, second.secret)).toBe("accepted");
    expect(await callsOf(second.key)).toEqual(["checkSignIn"]);
  });

  it("refuses a session signed out while its sign-in is asked, whatever the late answer says", async () => {
    const { name, secret, key } = await signIn(person());
    await hold(key);
    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS);

    const pending = authenticate(name, secret);
    await expect.poll(() => callsOf(key)).toEqual(["checkSignIn"]);
    // A sign-out on another connection ends the session (and asks the held account to end it too).
    const signedOut = env.TEST_USER.getByName(name).signOut(secret).catch(() => {});
    await expect.poll(() => sessions(name)).toEqual([]);
    await release(key);

    expect(await pending).toBe("invalid session token");
    await signedOut;
  });

  it("keeps a fresh sign-in's session when a late answer about the old one says it ended", async () => {
    const who = person();
    const old = await signIn(who);
    await answer(old.key, "ended");
    await hold(old.key);
    await ageChecks(old.name, SIGN_IN_CHECK_INTERVAL_MS);

    const pending = authenticate(old.name, old.secret);
    await expect.poll(() => callsOf(old.key)).toEqual(["checkSignIn"]);
    const renewed = await signIn(who);
    await release(old.key);

    expect(await pending).toBe("invalid session token");
    expect(await authenticate(renewed.name, renewed.secret)).toBe("accepted");
    expect((await sessions(old.name)).map(s => s.backing?.id)).toHaveLength(1);
  });

  it("ends when its backing record is gone, asking nothing", async () => {
    const { name, secret, key } = await signIn(person());
    await inUser(name, ({ storage }) => {
      for (const record of Array.from(storage.signInBackings.list())) storage.signInBackings.delete(record.id);
    });
    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS);

    expect(await authenticate(name, secret)).toBe("invalid session token");
    expect(await callsOf(key)).toEqual([]);
  });
});

/**
 * Makes every read of a sign-in backing in user DO `name` throw, as one whose stub no longer
 * deserializes (its Worker unbound) does, for as long as the DO stays in memory.
 */
const breakBackingReads = (name: string) => inUser(name, ({ storage }) => {
  storage.signInBackings.get = () => { throw new Error("the stub no longer deserializes"); };
});

describe("a backing that can't be read", () => {
  it("ends its session at the next check, asking nothing", async () => {
    const { name, secret, key } = await signIn(person());
    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS);
    await breakBackingReads(name);

    expect(await authenticate(name, secret)).toBe("invalid session token");
    expect(await sessions(name)).toEqual([]);
    expect(await callsOf(key)).toEqual([]);
  });

  it("still lets a sign-out end every session it backs", async () => {
    const who = person();
    const first = await signIn(who);
    const second = await signIn(who);
    await breakBackingReads(first.name);

    await env.TEST_USER.getByName(first.name).signOut(first.secret);

    expect(await sessions(first.name)).toEqual([]);
    expect(await backings(first.name)).toEqual([]);
    expect(await authenticate(second.name, second.secret)).toBe("invalid session token");
    expect(await callsOf(first.key)).toEqual([]);
  });
});

describe("session expiry", () => {
  it("refuses a session past its expiry, and forgets it", async () => {
    const { name } = await signIn(person());
    const secret = await plantSession(name, { created: new Date(Date.now() - DAY), expiresAt: new Date(Date.now() - 1000) });
    const before = (await sessions(name)).length;

    expect(await authenticate(name, secret)).toBe("invalid session token");
    expect(await sessions(name)).toHaveLength(before - 1);
  });

  it("gives a session from before expiry existed thirty days from its creation", async () => {
    const { name } = await signIn(person());
    const recent = await plantSession(name, { created: new Date(Date.now() - DAY) });
    const old = await plantSession(name, { created: new Date(Date.now() - SESSION_LIFETIME_MS - 1000) });

    expect(await authenticate(name, recent)).toBe("accepted");
    expect(await authenticate(name, old)).toBe("invalid session token");
  });

  it("gives a password sign-in's session thirty days", async () => {
    const username = `pw-${fresh()}`;
    const secret = await env.TEST_USER.getByName(username).createAccount(username, username, new Uint8Array([1]));
    const [session] = await sessions(username);
    expect(session!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + SESSION_LIFETIME_MS - 60_000);
    expect(session!.backing).toBeUndefined();
    expect(await authenticate(username, secret!)).toBe("accepted");
  });
});

describe("signing out", () => {
  it("ends the session, the sign-in behind it everywhere, and every session a sign-in through the same provider backs", async () => {
    const who = person();
    const first = await signIn(who);
    const second = await signIn(who);
    // A session no sign-in backs (as a password sign-in mints) is another sign-in, and stays.
    const unbacked = await plantSession(first.name, { created: new Date(), expiresAt: new Date(Date.now() + DAY) });

    await env.TEST_USER.getByName(first.name).signOut(first.secret);

    // One sign-out at InferLab ends the person's sign-in there, the second session's included.
    expect(await callsOf(first.key)).toEqual(["endSignIn"]);
    expect(await callsOf(second.key)).toEqual([]);
    expect(await authenticate(first.name, first.secret)).toBe("invalid session token");
    expect(await authenticate(second.name, second.secret)).toBe("invalid session token");
    expect(await authenticate(first.name, unbacked)).toBe("accepted");
    expect(await backings(first.name)).toEqual([]);

    // Idempotent, and a malformed token ends nothing.
    await env.TEST_USER.getByName(first.name).signOut(first.secret);
    await env.TEST_USER.getByName(first.name).signOut("not base64!");
    expect(await callsOf(first.key)).toEqual(["endSignIn"]);
    expect(await authenticate(first.name, unbacked)).toBe("accepted");
  });

  it("throws when the sign-in could not be ended everywhere, with the sessions already gone", async () => {
    const who = person();
    const first = await signIn(who);
    const second = await signIn(who);
    await answer(first.key, "down");

    const failure = await env.TEST_USER.getByName(first.name).signOut(first.secret)
      .then(() => null, (error: Error) => error.message);

    // The provider's own error is logged; the caller is told only that the provider's sign-out failed.
    expect(failure).toBe(SIGN_OUT_ERROR_MESSAGES[SIGN_OUT_ERROR_CODES.providerSignOutFailed]);
    expect(await callsOf(first.key)).toEqual(["endSignIn"]);
    expect(await authenticate(first.name, first.secret)).toBe("invalid session token");
    expect(await authenticate(second.name, second.secret)).toBe("invalid session token");
  });

  it("treats a provider sign-out that does not answer in time as failed", { timeout: 30_000 }, async () => {
    const { name, secret, key } = await signIn(person());
    await hold(key);
    try {
      const failure = await env.TEST_USER.getByName(name).signOut(secret)
        .then(() => null, (error: Error) => error.message);

      expect(failure).toBe(SIGN_OUT_ERROR_MESSAGES[SIGN_OUT_ERROR_CODES.providerSignOutFailed]);
      expect(await authenticate(name, secret)).toBe("invalid session token");
    } finally {
      await release(key);
    }
  });

  it("ends a session no sign-in backs without asking any account", async () => {
    const { name, key } = await signIn(person());
    const secret = await plantSession(name, { created: new Date(), expiresAt: new Date(Date.now() + DAY) });

    await env.TEST_USER.getByName(name).signOut(secret);

    expect(await authenticate(name, secret)).toBe("invalid session token");
    expect(await callsOf(key)).toEqual([]);
  });
});

describe("a connection authenticated with a session (FAC-300)", () => {
  it("stops working once a sign-out on another connection ends its session", async () => {
    const who = person();
    const first = await signIn(who);
    const second = await signIn(who);
    // A session no sign-in backs, which the sign-out leaves alone.
    const unbacked = await plantSession(first.name, { created: new Date(), expiresAt: new Date(Date.now() + DAY) });
    using firstConnection = await connect();
    using secondConnection = await connect();
    using thirdConnection = await connect();
    using signingOut = await firstConnection.authenticate(`${first.name}:${first.secret}`);
    using other = await secondConnection.authenticate(`${second.name}:${second.secret}`);
    using bystander = await thirdConnection.authenticate(`${first.name}:${unbacked}`);
    expect(await state(other)).toBe("working");

    // The connection that signs out is answered, not closed under its own call.
    await signingOut.signOut();

    await expect.poll(() => state(other)).toBe("refused");
    expect(await state(bystander)).toBe("working");
    using again = await connect();
    await expect(again.authenticate(`${second.name}:${second.secret}`)).rejects.toThrow("invalid session token");
  });

  it("stops working once another connection's check finds the sign-in behind it ended", async () => {
    const { name, secret, key } = await signIn(person());
    using watching = await connect();
    using api = await watching.authenticate(`${name}:${secret}`);
    expect(await state(api)).toBe("working");

    await answer(key, "ended");
    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS);
    expect(await authenticate(name, secret)).toBe("invalid session token");

    await expect.poll(() => state(api)).toBe("refused");
  });

  it("closes once the sign-in behind it ended at InferLab, with nobody authenticating again", async () => {
    const { name, secret, key } = await signIn(person());
    using watching = await connect();
    using api = await watching.authenticate(`${name}:${secret}`);
    expect(await state(api)).toBe("working");
    // Signed out in another InferLab app: only InferLab knows.
    await answer(key, "ended");

    // The re-check the timer runs asks nothing before the interval.
    await env.TEST_USER.getByName(name).recheckWatchedSessions();
    expect(await callsOf(key)).toEqual([]);
    expect(await state(api)).toBe("working");

    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS);
    await env.TEST_USER.getByName(name).recheckWatchedSessions();

    expect(await callsOf(key)).toEqual(["checkSignIn"]);
    await expect.poll(() => state(api)).toBe("refused");
    expect(await sessions(name)).toEqual([]);
  });

  it("is refused at once when its session ended before the watch began", async () => {
    const { name, secret } = await signIn(person());
    using connection = await connect();
    const api = connection.authenticate(`${name}:${secret}`);
    await env.TEST_USER.getByName(name).signOut(secret);
    await expect.poll(() => state(api)).toBe("refused");
  });
});

describe("signing out on a connection (FAC-300)", () => {
  it("is answered though another API on the same connection watches the same session", async () => {
    const { name, secret, key } = await signIn(person());
    using connection = await connect();
    // As the root route and the blueprint page each authenticate with the stored token.
    using signingOut = await connection.authenticate(`${name}:${secret}`);
    using other = await connection.authenticate(`${name}:${secret}`);
    expect(await state(other)).toBe("working");
    await hold(key);

    const outcome = signingOut.signOut().then(() => "done", (error: Error) => error.message);
    await expect.poll(() => callsOf(key)).toEqual(["endSignIn"]);
    // The session is gone and the other API's watch has fired while InferLab is still being asked.
    await expect.poll(() => sessions(name)).toEqual([]);
    // That watch ended rather than being set up again, which would find no session and end at once,
    // over and over, for as long as InferLab is asked.
    const requested = await inUser(name, ({ sessionWatches }) => sessionWatches.requested);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await inUser(name, ({ sessionWatches }) => sessionWatches.requested)).toBe(requested);
    await release(key);

    expect(await outcome).toBe("done");
  });

  it("stops working on the connection it was called on once it has been answered", async () => {
    const { name, secret } = await signIn(person());
    using connection = await connect();
    using api = await connection.authenticate(`${name}:${secret}`);

    await api.signOut();

    await expect.poll(() => state(api)).toBe("refused");
  });

  it("stops working there too when InferLab could not sign out, telling the client so", async () => {
    const { name, secret, key } = await signIn(person());
    await answer(key, "down");
    using connection = await connect();
    using api = await connection.authenticate(`${name}:${secret}`);

    const failure = await api.signOut().then(() => null, (error: unknown) => error);

    expect(getSignOutErrorCode(failure)).toBe(SIGN_OUT_ERROR_CODES.providerSignOutFailed);
    await expect.poll(() => state(api)).toBe("refused");
  });
});

/** How many sessions the user DO `name` watches, and whether its re-check timer is armed. */
const watches = (name: string) => inUser(name, ({ sessionWatches }) =>
  ({ watched: sessionWatches.counts.size, armed: sessionWatches.timer !== undefined }));

describe("the user DO's session watches (FAC-300)", () => {
  it("arms the re-check with the first watch, and stops it when the client lets the last one go", async () => {
    const { name, secret } = await signIn(person());
    expect(await watches(name)).toEqual({ watched: 0, armed: false });
    using connection = await connect();
    const api: RpcStub<AuthenticatedApi> = await connection.authenticate(`${name}:${secret}`);
    await expect.poll(() => watches(name)).toEqual({ watched: 1, armed: true });

    api[Symbol.dispose]();

    // The DO-side subscriber and its count go with the client's stub, and the timer with them.
    await expect.poll(() => watches(name)).toEqual({ watched: 0, armed: false });
  });

  it("re-arms after each re-check, and closes the connection once the sign-in has ended", async () => {
    const { name, secret, key } = await signIn(person());
    await inUser(name, ({ sessionWatches }) => { sessionWatches.intervalMs = 20; });
    using connection = await connect();
    using api = await connection.authenticate(`${name}:${secret}`);
    await expect.poll(() => watches(name)).toEqual({ watched: 1, armed: true });
    await answer(key, "ended");

    // Several re-checks run, asking nothing while the last confirmation is fresh.
    const first = await inUser(name, ({ sessionWatches }) => sessionWatches.timer);
    await expect.poll(() => inUser(name, ({ sessionWatches }) => sessionWatches.timer !== first
      && sessionWatches.timer !== undefined)).toBe(true);
    expect(await callsOf(key)).toEqual([]);
    expect(await state(api)).toBe("working");

    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS);

    await expect.poll(() => state(api)).toBe("refused");
    expect(await callsOf(key)).toEqual(["checkSignIn"]);
  });

  it("is set up again after the user DO resets, and still closes the connection", async () => {
    const { name, secret } = await signIn(person());
    using connection = await connect();
    using api = await connection.authenticate(`${name}:${secret}`);
    await expect.poll(() => watches(name)).toEqual({ watched: 1, armed: true });

    await runInDurableObject(env.TEST_USER.getByName(name), (_instance, doState) => {
      doState.abort("user-DO reset injected by test");
    }).catch(() => {});

    // The new incarnation knows the watch only because the connection set it up again.
    await expect.poll(() => watches(name)).toEqual({ watched: 1, armed: true });
    expect(await state(api)).toBe("working");
    await env.TEST_USER.getByName(name).signOut(secret);
    await expect.poll(() => state(api)).toBe("refused");
  });
});
