// @vitest-environment node
import { describe, expect, it } from "vitest";
import { restore } from "cloudflare:workers";
import { ALERT_PERMISSION, ExportHandler, Gadget, failureOf } from "../files/server.ts";
import type { GadgetEnv, ProjectSession } from "../files/lib/protocol.ts";

type Location = Awaited<ReturnType<ProjectSession["listLocations"]>>["items"][number];

const location = (id: string, status: "none" | "requested"): Location =>
  ({ ref: { id }, name: `Location ${id}`, review: { status } });

/** A session over `pages` of Locations, each page handing the next one's index as its cursor. */
function session(pages: Location[][], calls: unknown[] = []): ProjectSession {
  return {
    getProject: async () => ({ key: "PROOF", name: "Proof Project" }),
    subscribe: async () => {},
    listLocations: async (options) => {
      calls.push(options);
      const index = options?.cursor === undefined ? 0 : Number(options.cursor);
      const nextCursor = index + 1 < pages.length ? String(index + 1) : undefined;
      return { items: pages[index] ?? [], ...(nextCursor === undefined ? {} : { nextCursor }) };
    },
  };
}

function named(name: string): Error {
  const error = new Error("from the gatekeeper");
  error.name = name;
  return error;
}

function gadget(env: GadgetEnv, stored = new Map<string, unknown>()) {
  const state = { storage: { list: async () => new Map(stored) } } as unknown as DurableObjectState;
  return new Gadget(state, env);
}

describe("Review Alerts server", () => {
  it("says it is not connected, rather than answering an empty list, when nothing is bound", async () => {
    expect(await gadget({}).getReviewAlerts()).toEqual({
      state: "notConnected",
      message: "Not connected: connect an InferLab operations Project.",
    });
  });

  it("returns only the Locations a review was requested for, across every page", async () => {
    const calls: unknown[] = [];
    const PROJECT = session([
      [location("1", "requested"), location("2", "none")],
      [location("3", "none")],
      [location("4", "requested")],
    ], calls);
    expect(await gadget({ PROJECT }).getReviewAlerts()).toEqual({
      state: "ready",
      project: { key: "PROOF", name: "Proof Project" },
      waiting: [{ id: "1", name: "Location 1" }, { id: "4", name: "Location 4" }],
      incomplete: false,
    });
    expect(calls).toEqual([{ limit: 100 }, { cursor: "1", limit: 100 }, { cursor: "2", limit: 100 }]);
  });

  it("answers an empty list when no Location is waiting", async () => {
    const PROJECT = session([[location("1", "none")]]);
    expect(await gadget({ PROJECT }).getReviewAlerts()).toMatchObject({ state: "ready", waiting: [], incomplete: false });
  });

  it("stops after 20 pages and says the list may be incomplete", async () => {
    const calls: unknown[] = [];
    const pages = Array.from({ length: 25 }, (_, i) => [location(String(i), "requested")]);
    const result = await gadget({ PROJECT: session(pages, calls) }).getReviewAlerts();
    expect(calls).toHaveLength(20);
    expect(result).toMatchObject({ state: "ready", incomplete: true });
    expect(result.state === "ready" && result.waiting).toHaveLength(20);
  });

  it("stops at a cursor it was already given, rather than paging forever", async () => {
    const calls: unknown[] = [];
    const PROJECT: ProjectSession = {
      getProject: async () => ({ key: "PROOF", name: "Proof Project" }),
      subscribe: async () => {},
      listLocations: async (options) => {
        calls.push(options);
        return { items: [location(String(calls.length), "requested")], nextCursor: "same" };
      },
    };
    const result = await gadget({ PROJECT }).getReviewAlerts();
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ state: "ready", incomplete: true });
  });

  it.each([
    ["NotFound", "This Project wasn't found, or the person who connected it can no longer see it."],
    ["Forbidden", "The person who connected this Project may not read its Locations."],
    ["ConnectionExpired", "The InferLab operations connection expired or was revoked. Reconnect it to see review alerts."],
  ])("explains a %s refusal in its own words", async (name, message) => {
    const PROJECT: ProjectSession = {
      getProject: async () => { throw named(name); },
      listLocations: async () => { throw new Error("not reached"); },
      subscribe: async () => {},
    };
    expect(await gadget({ PROJECT }).getReviewAlerts()).toEqual({ state: "failed", reason: name, message });
  });

  it("does not repeat the text of an error it does not know", async () => {
    const PROJECT: ProjectSession = {
      getProject: async () => ({ key: "PROOF", name: "Proof Project" }),
      listLocations: async () => { throw new Error("upstream said something private"); },
      subscribe: async () => {},
    };
    const result = await gadget({ PROJECT }).getReviewAlerts();
    expect(result).toEqual({
      state: "failed", reason: "Unexpected", message: "Couldn't read this Project from InferLab operations. Try again.",
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("names only the documented failures", () => {
    expect(failureOf(named("ConnectionExpired"))).toBe("ConnectionExpired");
    expect(failureOf(named("TypeError"))).toBe("Unexpected");
    expect(failureOf("NotFound")).toBe("Unexpected");
    expect(failureOf(undefined)).toBe("Unexpected");
  });

  it("keeps nothing in storage, and reports what is there", async () => {
    expect(await gadget({ PROJECT: session([[location("1", "requested")]]) }).storedKeyCount()).toBe(0);
    expect(await gadget({}, new Map([["copied", 1]])).storedKeyCount()).toBe(1);
  });

  it("offers a PDF of the page and nothing else", async () => {
    const handler = new ExportHandler({} as ExecutionContext, {});
    expect(await handler.getExportFormats()).toEqual([
      { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
    ]);
  });
});

// FAC-239: watching for reviews. One hook, made once; each event raises one attention intent for
// the holders of location:write in the event's workspace, citing InferOps' event id.
describe("Review Alerts watching", () => {
  const storage = () => {
    const data = new Map<string, unknown>();
    return {
      data,
      get: async (k: string) => data.get(k),
      put: async (k: string, v: unknown) => { data.set(k, v); },
      list: async () => new Map(data),
    };
  };
  const watcher = (env: GadgetEnv, store = storage()) => {
    const restored: unknown[] = [];
    const state = { storage: store, restore: async (p: unknown) => { restored.push(p); return { stub: p }; } };
    return { g: new Gadget(state as unknown as DurableObjectState, env), store, restored };
  };
  const subscribing = (fail?: Error) => {
    const subscribed: unknown[] = [];
    const PROJECT = {
      ...session([[]]),
      subscribe: async (hook: unknown) => { if (fail) throw fail; subscribed.push(hook); },
    };
    return { PROJECT, subscribed };
  };

  it("is not connected without a Project, and makes nothing", async () => {
    const { g, store } = watcher({});
    expect(await g.watchReviews()).toMatchObject({ state: "notConnected" });
    expect(store.data.size).toBe(0);
  });

  it("subscribes one persistent hook, once, and stores only that it did", async () => {
    const { PROJECT, subscribed } = subscribing();
    const { g, store, restored } = watcher({ PROJECT });
    expect(await g.watchReviews()).toEqual({
      state: "watching", created: true, message: "Watching for reviews. Turn the hook on in Activity to be alerted.",
    });
    expect(await g.watchReviews()).toMatchObject({ state: "watching", created: false });
    expect(restored).toEqual([{ type: "review-alerts" }]);
    expect(subscribed).toEqual([{ stub: { type: "review-alerts" } }]);
    expect([...store.data.keys()]).toEqual(["watching"]);
  });

  it("says why when it can't watch, and stores nothing", async () => {
    const { PROJECT } = subscribing(new Error("no events here"));
    const { g, store } = watcher({ PROJECT });
    expect(await g.watchReviews()).toEqual({
      state: "failed",
      message: "This InferOS doesn't receive InferOps events for that workspace, so it can't watch for reviews.",
    });
    expect(store.data.size).toBe(0);
    const { PROJECT: expired } = subscribing(named("ConnectionExpired"));
    expect(await watcher({ PROJECT: expired }).g.watchReviews()).toMatchObject({
      state: "failed", message: expect.stringContaining("expired or was revoked"),
    });
  });

  it("restores its own hook only, and the hook raises exactly the attention intent", async () => {
    const raised: unknown[] = [];
    const ATTENTION = { raise: async (intent: unknown) => { raised.push(intent); return { recipients: 1 }; } };
    const { g } = watcher({ ATTENTION });
    await expect(g[restore]({ type: "other" })).rejects.toThrow("Unknown restore type: other");
    const hook = await g[restore]({ type: "review-alerts" });
    const target = { v: 1 as const, tenantId: "00000000-0000-4000-8000-000000000c01", kind: "project/location", id: "loc-1" };
    await hook.receiveEvent({ eventId: "evt-1", workspaceId: "ws-1", location: { ref: target } });
    expect(raised).toEqual([{
      v: 1, sourceEventId: "evt-1", reason: "review_requested", target,
      audience: { kind: "permission-holders", workspaceId: "ws-1", permission: "location:write" },
    }]);
    expect(ALERT_PERMISSION).toBe("location:write");
  });

  it("a hook without the attention capability fails loudly", async () => {
    const hook = await watcher({}).g[restore]({ type: "review-alerts" });
    await expect(hook.receiveEvent({ eventId: "e", workspaceId: "w", location: { ref: { v: 1, tenantId: "t", kind: "k", id: "i" } } }))
      .rejects.toThrow("Attention is unavailable");
  });
});
