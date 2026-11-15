// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AttentionItem, AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { AttentionList } from "./AttentionList";
import { AttentionSummary } from "./AttentionSummary";

const mock = vi.hoisted(() => ({ goTo: vi.fn<(url: string) => void>(), toast: vi.fn() }));
vi.mock("./goToInferWork", () => ({ goToInferWork: mock.goTo }));
vi.mock("@cloudflare/kumo", async original => ({
  ...await original<typeof import("@cloudflare/kumo")>(),
  useKumoToastManager: () => ({ add: mock.toast }),
}));

const item = (key: string, personal: AttentionItem["personal"], at = "2026-11-14T20:00:00.000Z"): AttentionItem => ({
  v: 1, itemKey: key, recipient: { issuer: "https://auth.example", subject: "owner" },
  sourceEventId: "6f1c2a8e-4b1d-4c55-9a3e-2f6d8b1e0a01", reason: "review_requested",
  target: { v: 1, tenantId: "00000000-0000-4000-8000-000000000c01", kind: "project/location", id: `loc-${key}` },
  personal, createdAt: at,
});

const getAttentionItems = vi.fn<AuthenticatedApi["getAttentionItems"]>();
const describeAttentionItems = vi.fn<AuthenticatedApi["describeAttentionItems"]>();
const openAttentionItem = vi.fn<AuthenticatedApi["openAttentionItem"]>();
const setAttentionState = vi.fn<AuthenticatedApi["setAttentionState"]>();
let api: object;
vi.mock("../../AuthContext", () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }));

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  // A fresh API object per test, so the shared per-API store starts empty.
  api = { getAttentionItems, describeAttentionItems, openAttentionItem, setAttentionState };
  setAttentionState.mockResolvedValue(undefined);
  vi.stubGlobal("scrollTo", vi.fn<() => void>());
  describeAttentionItems.mockImplementation(async keys => keys.map(key => `Label ${key}`));
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const render = async (node: () => ReactElement) => {
  const router = createRouter({ routeTree: createRootRoute({ component: node }),
    history: createMemoryHistory({ initialEntries: ["/"] }) });
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
};
const text = () => container.textContent ?? "";
const rows = () => [...container.querySelectorAll<HTMLElement>("[data-testid=attention-row]")];
const button = (row: HTMLElement | Document, name: string) =>
  [...row.querySelectorAll("button")].find(b => b.textContent === name);
const click = async (el: Element | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
};

it("draws loading, then empty, as their own states", async () => {
  let resolve!: (items: AttentionItem[]) => void;
  getAttentionItems.mockReturnValue(new Promise(r => { resolve = r; }));
  await render(() => <AttentionList />);
  expect(container.querySelector("[aria-label='Loading what needs your attention']")).not.toBeNull();
  expect(text()).not.toContain("Nothing needs your attention.");
  await act(async () => resolve([]));
  expect(text()).toContain("Nothing needs your attention.");
});

it("shows a failure to read the list as an error with Retry, never as an empty list", async () => {
  getAttentionItems.mockRejectedValueOnce(new Error("InferOps unavailable")).mockResolvedValue([item("a", "unread")]);
  await render(() => <AttentionList />);
  expect(container.querySelector("[role=alert]")?.textContent).toContain("Couldn’t check what needs your attention.");
  expect(text()).not.toContain("Nothing needs your attention.");
  await click(button(container, "Retry"));
  expect(rows()).toHaveLength(1);
});

it("shows a failure to read the labels as an error too, never as 'no longer available'", async () => {
  getAttentionItems.mockResolvedValue([item("a", "unread")]);
  describeAttentionItems.mockRejectedValue(new Error("InferOps unavailable"));
  await render(() => <AttentionList />);
  expect(container.querySelector("[role=alert]")).not.toBeNull();
  expect(text()).not.toContain("No longer available");
});

it("opens only through the link the server returns, marking the item read", async () => {
  getAttentionItems.mockResolvedValue([item("a", "unread")]);
  openAttentionItem.mockResolvedValue({ url: "https://work.example.test/r/project/location/loc-a" });
  await render(() => <AttentionList />);
  const [row] = rows();
  expect(row?.textContent).toContain("Label a");
  expect(row?.textContent).toContain("Review requested");
  expect(mock.goTo).not.toHaveBeenCalled();
  await click(button(row!, "Open"));
  expect(openAttentionItem).toHaveBeenCalledWith("a");
  expect(mock.goTo).toHaveBeenCalledExactlyOnceWith("https://work.example.test/r/project/location/loc-a");
  expect(setAttentionState).toHaveBeenCalledWith("a", "read");
});

it("never navigates when the server refuses the open, and says so", async () => {
  getAttentionItems.mockResolvedValue([item("a", "unread")]);
  openAttentionItem.mockRejectedValue(new Error("You can't open this now."));
  await render(() => <AttentionList />);
  await click(button(rows()[0]!, "Open"));
  expect(mock.goTo).not.toHaveBeenCalled();
  expect(mock.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn’t open this", variant: "error" }));
});

it("shows a target the person can no longer see as 'No longer available', with no Open", async () => {
  getAttentionItems.mockResolvedValue([item("a", "unread"), item("b", "unread")]);
  describeAttentionItems.mockImplementation(async keys => keys.map(key => (key === "b" ? null : `Label ${key}`)));
  await render(() => <AttentionList />);
  const gone = rows().find(row => row.dataset.itemKey === "b")!;
  expect(gone.textContent).toContain("No longer available");
  expect(gone.textContent).not.toContain("Label b");
  expect(button(gone, "Open")).toBeUndefined();
});

it("changes only the person's own state: read, unread and dismissed, never the review", async () => {
  getAttentionItems.mockResolvedValue([item("a", "unread"), item("d", "dismissed")]);
  await render(() => <AttentionList />);
  expect(rows().map(row => row.dataset.itemKey)).toEqual(["a"]);
  await click(button(rows()[0]!, "Mark read"));
  await click(button(rows()[0]!, "Dismiss"));
  expect(setAttentionState.mock.calls).toEqual([["a", "read"], ["a", "dismissed"]]);
  expect(openAttentionItem).not.toHaveBeenCalled();
  // Dismissed items are behind the toggle.
  getAttentionItems.mockResolvedValue([item("a", "dismissed"), item("d", "dismissed")]);
  await click(button(container, "Show dismissed (2)") ?? button(container, "Show dismissed (1)"));
  expect(rows().map(row => row.dataset.itemKey)).toEqual(["a", "d"]);
});

it("counts unread, undismissed items on the sidebar badge", async () => {
  getAttentionItems.mockResolvedValue([item("a", "unread"), item("b", "read"), item("c", "unread"), item("d", "dismissed")]);
  await render(() => <AttentionSummary collapsed={false} />);
  expect(container.querySelector("[aria-label='2 items need your attention']")).not.toBeNull();
});
