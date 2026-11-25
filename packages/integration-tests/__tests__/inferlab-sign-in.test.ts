// One Google sign-in through InferLab central auth (FAC-300), end to end: signing in to InferOS also
// connects InferOps, with the InferLab session kept as the connection and backing the Workshop
// session; a later sign-in reuses the browser's live central-auth sign-in (`prompt=none`) without
// any page; signing out ends the person's sign-in everywhere (`POST /auth/sign-out`) and every
// Workshop session it backs; and the next sign-in asks for the account chooser.
//
// The real Workshop and InferOps gatekeeper Worker against the fake InferLab and InferOps
// (src/inferops-fake.ts), whose central auth models root and child sessions in one browser.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { startHarness, type Harness } from "../src/harness.js";
import { INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, type FakePerson } from "../src/inferops-fake.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, nextUsernames, waitFor } from "../src/rpc-client.js";

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";

const fake = new InferOpsFake();
const network = new NetworkInterceptor({ handlers: [fake.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{
      binding: "INFEROPS",
      dir: INFEROPS_GATEKEEPER_DIR,
      patch: config => {
        if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
        config.vars = {
          ...config.vars,
          INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN,
          INFEROPS_BASE_URL: INFEROPS_ORIGIN,
          BASE_URL: "http://workshop.test/gatekeeper/inferops",
        };
      },
    }],
    patchWorkshop(config) {
      config.vars = { ...config.vars, AUTH_GATEKEEPERS: VENDOR };
    },
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/**
 * Signs in through the Workshop as the login page does: the popup's legs through the gatekeeper and
 * InferLab (`person` signs in when InferLab shows a page), the popup's confirmation, then the
 * attempt's token. Returns the session token and the prompts InferLab was asked with.
 */
async function signIn(person: FakePerson, chooseAccount: boolean): Promise<{ token: string; prompts: (string | null)[] }> {
  const promptsBefore = fake.prompts.length;
  using api = connect(harness.url);
  const { url, nonce, attempt } = await api.startGatekeeperLogin(VENDOR, { chooseAccount });
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, url, { redirect: "manual" });
  expect(start.status).toBe(302);
  let done = await harness.fetchWorker(GATEKEEPER_WORKER,
    fake.authorize(start.headers.get("location")!, person), { redirect: "manual" });
  // No live sign-in for a silent leg: the popup goes on to the interactive one.
  if (done.status === 302) {
    done = await harness.fetchWorker(GATEKEEPER_WORKER,
      fake.authorize(done.headers.get("location")!, person), { redirect: "manual" });
  }
  const html = await done.text();
  expect(done.status, html).toBe(200);
  const literal = /var ticket = (".*?");\n/.exec(html);
  if (!literal) throw new Error("The handoff page carried no ticket");
  await api.confirmLogin(JSON.parse(literal[1]!), nonce);
  const token = await waitFor("the session token", () => attempt.receive());
  return { token, prompts: fake.prompts.slice(promptsBefore) };
}

/** "accepted", or the refusal's message. */
async function authenticate(token: string): Promise<string> {
  using api = connect(harness.url);
  try {
    using authenticated = await api.authenticate(token);
    await authenticated.whoami();
    return "accepted";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("one Google sign-in through InferLab", () => {
  const [label] = nextUsernames("ada");
  const person = fake.addPerson(label!, ["operations"]);
  let first: string;
  let second: string;

  it("connects InferOps with the sign-in, keeping its InferLab session as the connection", async () => {
    const signedIn = await signIn(person, false);
    first = signedIn.token;

    // Silent first; with no central-auth sign-in in the browser, the interactive leg asks nothing.
    expect(signedIn.prompts).toEqual(["none", null]);
    expect(fake.browserSignedIn()).toBe(person);
    expect(fake.logouts).toEqual([]);
    using api = connect(harness.url);
    using authenticated = await api.authenticate(first);
    const accounts = await waitFor("the connected InferOps account", async () => {
      const found = (await listConnectedAccounts(authenticated)).filter(a => a.vendorId === VENDOR);
      return found.length > 0 ? found : null;
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ credentialsValid: true, description: { uniqueName: person.email } });
  });

  it("reuses the browser's live sign-in without a page, replacing the connection rather than adding one", async () => {
    const signedIn = await signIn(person, false);
    second = signedIn.token;

    expect(signedIn.prompts).toEqual(["none"]);
    // The account's previous InferLab session is ended as the new one replaces it.
    expect(fake.logouts).toHaveLength(1);
    using api = connect(harness.url);
    using authenticated = await api.authenticate(second);
    expect((await listConnectedAccounts(authenticated)).filter(a => a.vendorId === VENDOR)).toHaveLength(1);
    expect(await authenticate(first)).toBe("accepted");
  });

  it("signs out everywhere: the person's InferLab sign-in and every Workshop session it backs", async () => {
    {
      using api = connect(harness.url);
      using authenticated = await api.authenticate(second);
      await authenticated.signOut();
    }

    expect(fake.signOuts).toHaveLength(1);
    expect(fake.browserSignedIn()).toBeNull();
    expect(await authenticate(second)).toContain("invalid session token");
    expect(await authenticate(first)).toContain("invalid session token");
  });

  it("asks for the account chooser on the sign-in after a sign-out", async () => {
    const signedIn = await signIn(person, true);

    expect(signedIn.prompts).toEqual(["select_account"]);
    expect(await authenticate(signedIn.token)).toBe("accepted");
    using api = connect(harness.url);
    using authenticated = await api.authenticate(signedIn.token);
    const accounts = (await listConnectedAccounts(authenticated)).filter(a => a.vendorId === VENDOR);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.credentialsValid).toBe(true);
  });
});
