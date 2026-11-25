// One Google sign-in through InferLab central auth (FAC-300), end to end through the real Workshop
// and the real gatekeeper-inferlab, with InferLab faked (inferlab-fake.ts), whose central auth models
// root and child sessions in one browser: the sign-in keeps its InferLab session to back the
// Workshop session; a later sign-in reuses the browser's live central-auth sign-in (`prompt=none`)
// without any page; signing out ends the person's sign-in everywhere (`POST /auth/sign-out`) and
// every Workshop session a sign-in through InferLab backs; and the next sign-in asks for the account
// chooser.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, waitFor } from "../src/rpc-client.js";
import { FakeInferOps, SIGN_IN_WORKER, patchWorkshop, signInGatekeeper, ticketOf } from "./inferlab-fake.js";

const inferlab = new FakeInferOps();
const network = new NetworkInterceptor({ handlers: [inferlab.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [signInGatekeeper()],
    // Sign-in alone: the attention authority patchWorkshop binds lives in the operations gatekeeper.
    patchWorkshop: config => {
      patchWorkshop(config);
      config.services = config.services?.filter(service => service.binding !== "ATTENTION_AUTHORITY");
    },
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

/**
 * Signs in as the login page does: the popup's legs through the gatekeeper and InferLab, the
 * popup's confirmation, then the attempt's token. Returns the token and the prompts InferLab saw.
 */
async function signIn(chooseAccount: boolean): Promise<{ token: string; prompts: (string | null)[] }> {
  const before = inferlab.prompts.length;
  using api = connect(harness.url);
  const { url, nonce, attempt } = await api.startGatekeeperLogin("inferlab", { chooseAccount });
  let leg = await harness.fetchWorker(SIGN_IN_WORKER, url, { redirect: "manual" });
  // Each authorize leg comes back to /oauth; a silent leg InferLab can't complete goes on to another.
  while (leg.status === 302) {
    const location = leg.headers.get("location")!;
    const next = new URL(location).pathname === "/authorize" ? inferlab.authorize(location) : location;
    leg = await harness.fetchWorker(SIGN_IN_WORKER, next, { redirect: "manual" });
  }
  await api.confirmLogin(await ticketOf(leg), nonce);
  const token = await waitFor("the session token", async () => await attempt.receive());
  return { token, prompts: inferlab.prompts.slice(before) };
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
  let first: string;
  let second: string;

  it("keeps the sign-in's InferLab session, going on to Google when the browser has no live sign-in", async () => {
    const signedIn = await signIn(false);
    first = signedIn.token;
    // Silent first; with no central-auth sign-in in the browser, the interactive leg asks nothing.
    expect(signedIn.prompts).toEqual(["none", null]);
    expect(inferlab.browserSignedIn()).toBe(true);
    // Kept, not ended at once.
    expect(inferlab.logouts).toEqual([]);
    expect(await authenticate(first)).toBe("accepted");
  });

  it("reuses the browser's live sign-in without a page", async () => {
    const signedIn = await signIn(false);
    second = signedIn.token;
    expect(signedIn.prompts).toEqual(["none"]);
    expect(await authenticate(second)).toBe("accepted");
    expect(await authenticate(first)).toBe("accepted");
  });

  it("signs out everywhere: the person's InferLab sign-in and every Workshop session it backs", async () => {
    {
      using api = connect(harness.url);
      using authenticated = await api.authenticate(second);
      await authenticated.signOut();
    }

    expect(inferlab.signOuts).toHaveLength(1);
    expect(inferlab.browserSignedIn()).toBe(false);
    expect(await authenticate(second)).toContain("invalid session token");
    expect(await authenticate(first)).toContain("invalid session token");
  });

  it("asks for the account chooser on the sign-in after a sign-out", async () => {
    const signedIn = await signIn(true);
    expect(signedIn.prompts).toEqual(["select_account"]);
    expect(await authenticate(signedIn.token)).toBe("accepted");
  });
});
