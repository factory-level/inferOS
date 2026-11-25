// A Workshop session's life (FAC-300): every session expires, a session a provider sign-in backs
// (a vendor that declares `signInConnects`, like InferOps) lives only while that sign-in does, and
// signing out ends the session, the sign-in behind it everywhere, and every other session it backs,
// and closes every connection authenticated with one of them. Through the real login callback, user
// DO and API Worker, with a sign-in account that stands in for InferOps'.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import server from "../src/server.js";
import type { PendingLogin } from "../src/auth/login-flow.js";
import type { UserDurableObject } from "../src/user.js";
import {
  SESSION_LIFETIME_MS, SIGN_IN_CHECK_INTERVAL_MS, SIGN_IN_RETRY_INTERVAL_MS, SIGN_IN_UNCONFIRMED_LIMIT_MS,
} from "../src/user.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";
import type { FakeSignInAccount, TestLoginCallback } from "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_PENDING_LOGIN: DurableObjectNamespace<PendingLogin>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

type SignInProps = { key: string; issuer: string; subject: string; email: string };
type Exports = {
  FakeSignInAccount(options: { props: SignInProps }): Fetcher<FakeSignInAccount>;
  TestLoginCallback(options: { props: { pendingId: string; vendorId: string; subject?: boolean; connects?: boolean } }):
    Fetcher<TestLoginCallback>;
};
type SessionRecord = {
  tokenId: string; created: Date; expiresAt?: Date; backing?: { accountId: number; checkedAt: Date; failedAt?: Date };
};
type AccountRecord = { id: number; vendorId: string; credentialsExpired?: boolean };
// What a test reaches into a user DO for.
type Internals = {
  ctx: DurableObjectState & { exports: Exports };
  storage: {
    sessions: { list(): Iterable<SessionRecord>; get(id: string): SessionRecord | undefined; put(r: SessionRecord): void };
    connectedAccounts: { list(): Iterable<AccountRecord>; delete(id: number): void };
  };
};

const ISSUER = "https://auth.example.test";
const fresh = () => crypto.randomUUID().slice(0, 8);
const internals = (instance: UserDurableObject) => instance as unknown as Internals;

/** One person, as InferOps would sign them in: a principal and the address InferLab vouches for. */
function person() {
  const subject = fresh();
  return { subject, email: `ada-${subject}@example.test` };
}

/**
 * Signs `who` in through the real callback, for a vendor whose sign-in connects. `key` names the
 * sign-in account the gatekeeper hands over. Returns the account name and session secret.
 */
async function signIn(who: { subject: string; email: string }, key = fresh()): Promise<{ name: string; secret: string; key: string }> {
  const pending = env.TEST_PENDING_LOGIN.getByName(`session-login-${fresh()}`);
  await pending.begin();
  let ticket = "";
  await runInDurableObject(env.TEST_USER.getByName(`host-${fresh()}`), async (instance: UserDurableObject) => {
    const exports = internals(instance).ctx.exports;
    const callback = exports.TestLoginCallback({
      props: { pendingId: pending.id.toString(), vendorId: "inferops", subject: true, connects: true },
    });
    const account = exports.FakeSignInAccount({ props: { key, issuer: ISSUER, ...who } });
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

/** A sign-in account's recorded calls, asked through a stub minted in a DO's exports. */
function account(key: string, body: (stub: Fetcher<FakeSignInAccount>) => Promise<unknown>): Promise<unknown> {
  return inUser(`host-${fresh()}`, ({ ctx }) =>
    body(ctx.exports.FakeSignInAccount({ props: { key, issuer: ISSUER, subject: "", email: "" } })));
}
const callsOf = async (key: string) => await account(key, stub => stub.calls()) as string[];
const answer = (key: string, value: "live" | "ended" | "down") => account(key, stub => stub.setAnswer(value));
const hold = (key: string) => account(key, stub => stub.hold());
const release = (key: string) => account(key, stub => stub.release());

/** "accepted", or the refusal's message, caught on the call itself (see account-subject.test.ts). */
const authenticate = (name: string, secret: string) =>
  env.TEST_USER.getByName(name).authenticate(secret).then(() => "accepted", (error: Error) => error.message);

const sessions = (name: string) => inUser(name, ({ storage }) => [...storage.sessions.list()]);
const accounts = (name: string) => inUser(name, ({ storage }) => [...storage.connectedAccounts.list()]
  .map(({ id, vendorId, credentialsExpired }) => ({ id, vendorId, credentialsExpired: credentialsExpired ?? false })));

/** Moves every session's last confirmation of its backing sign-in `ageMs` into the past. */
const ageChecks = (name: string, ageMs: number) => inUser(name, ({ storage }) => {
  for (const session of Array.from(storage.sessions.list())) {
    if (session.backing) {
      storage.sessions.put({ ...session, backing: { ...session.backing, checkedAt: new Date(Date.now() - ageMs) } });
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

/** Moves every backed session's last failed check `ageMs` into the past. */
const ageFailures = (name: string, ageMs: number) => inUser(name, ({ storage }) => {
  for (const session of Array.from(storage.sessions.list())) {
    if (session.backing?.failedAt) {
      storage.sessions.put({ ...session, backing: { ...session.backing, failedAt: new Date(Date.now() - ageMs) } });
    }
  }
});

/**
 * A WebSocket API session with the Worker, sharing the test's execution context. This project binds
 * no AdminSettings Durable Object, so the bundled-blueprint install the first API request starts
 * finds one that reports it done.
 */
async function connect(): Promise<RpcStub<PublicApi>> {
  const base = createExecutionContext();
  const adminSettings = { getByName: () => ({ ensureBundledBlueprintsInstalled: async () => true }) };
  const exports = new Proxy(base.exports, {
    get: (target, name) => name === "AdminSettings" ? adminSettings : Reflect.get(target, name),
  });
  const ctx = new Proxy(base, {
    get: (target, name) => {
      if (name === "exports") return exports;
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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

describe("a sign-in that connects (FAC-300)", () => {
  it("links the account it signed in with, and backs the session with that account's sign-in", async () => {
    const { name, secret, key } = await signIn(person());

    const [linked] = await accounts(name);
    expect(linked).toMatchObject({ vendorId: "inferops", credentialsExpired: false });
    const [session] = await sessions(name);
    expect(session!.backing?.accountId).toBe(linked!.id);
    expect(session!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + SESSION_LIFETIME_MS - 60_000);
    // Confirmed live by the sign-in itself: nothing is asked until the interval has passed.
    expect(await authenticate(name, secret)).toBe("accepted");
    expect(await callsOf(key)).toEqual([]);
  });

  it("replaces the account's grant on a second sign-in, revoking the old one, rather than adding an account", async () => {
    const who = person();
    const first = await signIn(who);
    const second = await signIn(who);
    expect(second.name).toBe(first.name);

    const linked = await accounts(first.name);
    expect(linked).toHaveLength(1);
    expect(await callsOf(first.key)).toContain("revoke");
    // Both sessions are backed by the one account, which now holds the second sign-in's grant.
    expect((await sessions(first.name)).map(s => s.backing?.accountId)).toEqual([linked[0]!.id, linked[0]!.id]);
    expect(await authenticate(first.name, first.secret)).toBe("accepted");
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

  it("ends once the sign-in has ended anywhere, and the account shows as needing a reconnect", async () => {
    const { name, secret, key } = await signIn(person());
    await answer(key, "ended");
    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS);

    expect(await authenticate(name, secret)).toBe("invalid session token");
    expect(await sessions(name)).toEqual([]);
    expect((await accounts(name))[0]!.credentialsExpired).toBe(true);
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
    expect((await accounts(name))[0]!.credentialsExpired).toBe(false);

    // Answering again ends the backoff.
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

    // Inside the backoff too: an unanswered day ends the session without asking again.
    await ageChecks(name, SIGN_IN_UNCONFIRMED_LIMIT_MS);
    expect(await authenticate(name, secret)).toBe("invalid session token");
    expect(await callsOf(key)).toEqual(["checkSignIn"]);
    expect(await sessions(name)).toEqual([]);
    // Unanswered is not ended: the account is not marked expired.
    expect((await accounts(name))[0]!.credentialsExpired).toBe(false);
  });

  it("ends every session the sign-in backs once one check finds it ended", async () => {
    const who = person();
    const first = await signIn(who);
    const second = await signIn(who);
    await answer(second.key, "ended");
    await ageChecks(first.name, SIGN_IN_CHECK_INTERVAL_MS);

    expect(await authenticate(first.name, first.secret)).toBe("invalid session token");
    expect(await sessions(first.name)).toEqual([]);
    expect(await authenticate(second.name, second.secret)).toBe("invalid session token");
  });

  it("refuses the session, not the request, when its account vanishes while the sign-in is asked", async () => {
    const { name, secret, key } = await signIn(person());
    await answer(key, "ended");
    await hold(key);
    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS);

    const pending = authenticate(name, secret);
    await expect.poll(() => callsOf(key)).toEqual(["checkSignIn"]);
    await inUser(name, ({ storage }) => {
      for (const record of Array.from(storage.connectedAccounts.list())) storage.connectedAccounts.delete(record.id);
    });
    await release(key);

    expect(await pending).toBe("invalid session token");
  });

  it("keeps the account and the session when a fresh sign-in replaces the account while it is asked", async () => {
    const who = person();
    const first = await signIn(who);
    await answer(first.key, "ended");
    await hold(first.key);
    await ageChecks(first.name, SIGN_IN_CHECK_INTERVAL_MS);

    const pending = authenticate(first.name, first.secret);
    await expect.poll(() => callsOf(first.key)).toEqual(["checkSignIn"]);
    // The answer is about the grant the second sign-in replaced, and says nothing of the new one.
    const second = await signIn(who);
    await release(first.key);

    expect(await pending).toBe("accepted");
    expect((await accounts(first.name))[0]!.credentialsExpired).toBe(false);
    expect(await authenticate(second.name, second.secret)).toBe("accepted");
  });

  it("ends when its account was disconnected, asking nothing", async () => {
    const { name, secret, key } = await signIn(person());
    await inUser(name, ({ storage }) => {
      for (const record of Array.from(storage.connectedAccounts.list())) storage.connectedAccounts.delete(record.id);
    });
    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS);

    expect(await authenticate(name, secret)).toBe("invalid session token");
    expect(await callsOf(key)).toEqual([]);
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
});

describe("signing out", () => {
  it("ends the session, the sign-in behind it everywhere, and every session that sign-in backs", async () => {
    const who = person();
    const first = await signIn(who);
    const second = await signIn(who);
    // A session no sign-in backs (as a password sign-in mints) is another sign-in, and stays.
    const unbacked = await plantSession(first.name, { created: new Date(), expiresAt: new Date(Date.now() + DAY) });

    await env.TEST_USER.getByName(first.name).signOut(first.secret);

    expect(await callsOf(second.key)).toEqual(["endSignIn"]);
    expect(await authenticate(first.name, first.secret)).toBe("invalid session token");
    expect(await authenticate(second.name, second.secret)).toBe("invalid session token");
    expect(await authenticate(first.name, unbacked)).toBe("accepted");
    expect((await accounts(first.name))[0]!.credentialsExpired).toBe(true);

    // Idempotent, and a malformed token ends nothing.
    await env.TEST_USER.getByName(first.name).signOut(first.secret);
    await env.TEST_USER.getByName(first.name).signOut("not base64!");
    expect(await callsOf(second.key)).toEqual(["endSignIn"]);
    expect(await authenticate(first.name, unbacked)).toBe("accepted");
  });

  it("throws when the sign-in could not be ended everywhere, with the sessions already gone and the account expired", async () => {
    const who = person();
    const first = await signIn(who);
    const second = await signIn(who);
    await answer(second.key, "down");

    const failure = await env.TEST_USER.getByName(first.name).signOut(first.secret)
      .then(() => null, (error: Error) => error.message);

    expect(failure).toContain("HTTP 503");
    expect(await callsOf(second.key)).toEqual(["endSignIn"]);
    expect(await authenticate(first.name, first.secret)).toBe("invalid session token");
    expect(await authenticate(second.name, second.secret)).toBe("invalid session token");
    expect((await accounts(first.name))[0]!.credentialsExpired).toBe(true);
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

    // The re-check the timer runs (SESSION_RECHECK_INTERVAL_MS) asks nothing before the interval.
    await env.TEST_USER.getByName(name).recheckWatchedSessions();
    expect(await callsOf(key)).toEqual([]);
    expect(await state(api)).toBe("working");

    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS);
    await env.TEST_USER.getByName(name).recheckWatchedSessions();

    expect(await callsOf(key)).toEqual(["checkSignIn"]);
    await expect.poll(() => state(api)).toBe("refused");
    expect(await sessions(name)).toEqual([]);
    expect((await accounts(name))[0]!.credentialsExpired).toBe(true);
  });

  it("is refused at once when its session ended before the watch began", async () => {
    const { name, secret } = await signIn(person());
    using connection = await connect();
    const api = connection.authenticate(`${name}:${secret}`);
    await env.TEST_USER.getByName(name).signOut(secret);
    await expect.poll(() => state(api)).toBe("refused");
  });
});
