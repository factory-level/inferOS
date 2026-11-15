// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ExportHandler, Gadget, failureOf } from "../files/server.ts";
import type { GadgetEnv, ProjectSession } from "../files/lib/protocol.ts";

type Location = Awaited<ReturnType<ProjectSession["listLocations"]>>["items"][number];

const location = (id: string, status: "none" | "requested"): Location =>
  ({ ref: { id }, name: `Location ${id}`, review: { status } });

/** A session over `pages` of Locations, each page handing the next one's index as its cursor. */
function session(pages: Location[][], calls: unknown[] = []): ProjectSession {
  return {
    getProject: async () => ({ key: "PROOF", name: "Proof Project" }),
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
    };
    expect(await gadget({ PROJECT }).getReviewAlerts()).toEqual({ state: "failed", reason: name, message });
  });

  it("does not repeat the text of an error it does not know", async () => {
    const PROJECT: ProjectSession = {
      getProject: async () => ({ key: "PROOF", name: "Proof Project" }),
      listLocations: async () => { throw new Error("upstream said something private"); },
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
