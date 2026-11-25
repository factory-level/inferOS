// A Workshop session's life (FAC-300): every session expires, a session a provider sign-in backs
// (a vendor that declares `signInConnects`, like InferOps) lives only while that sign-in does, and
// signing out ends the session, the sign-in behind it everywhere, and every other session it backs.
// Through the real login callback and user DO, with a sign-in account that stands in for InferOps'.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { PendingLogin } from "../src/auth/login-flow.js";
import type { UserDurableObject } from "../src/user.js";
import { SESSION_LIFETIME_MS, SIGN_IN_CHECK_INTERVAL_MS } from "../src/user.js";
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
  tokenId: string; created: Date; expiresAt?: Date; backing?: { accountId: number; checkedAt: Date };
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

  it("stands when InferLab cannot answer, and asks again next time", async () => {
    const { name, secret, key } = await signIn(person());
    await answer(key, "down");
    await ageChecks(name, SIGN_IN_CHECK_INTERVAL_MS);

    expect(await authenticate(name, secret)).toBe("accepted");
    expect(await authenticate(name, secret)).toBe("accepted");
    expect(await callsOf(key)).toEqual(["checkSignIn", "checkSignIn"]);
    expect((await accounts(name))[0]!.credentialsExpired).toBe(false);
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

  it("ends a session no sign-in backs without asking any account", async () => {
    const { name, key } = await signIn(person());
    const secret = await plantSession(name, { created: new Date(), expiresAt: new Date(Date.now() + DAY) });

    await env.TEST_USER.getByName(name).signOut(secret);

    expect(await authenticate(name, secret)).toBe("invalid session token");
    expect(await callsOf(key)).toEqual([]);
  });
});
