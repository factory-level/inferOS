/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { Toasty } from "@cloudflare/kumo";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import type { AttentionItem } from "@gadgets/workshop-shared/api";
import { AttentionList } from "./AttentionList";
import "../../styles.css";

const mock = vi.hoisted(() => ({ goTo: vi.fn<(url: string) => void>() }));
vi.mock("./goToInferWork", () => ({ goToInferWork: mock.goTo }));

const item: AttentionItem = {
  v: 1, itemKey: "k1", recipient: { issuer: "https://auth.example", subject: "owner" },
  sourceEventId: "6f1c2a8e-4b1d-4c55-9a3e-2f6d8b1e0a01", reason: "review_requested",
  target: { v: 1, tenantId: "00000000-0000-4000-8000-000000000c01", kind: "project/location", id: "loc-1" },
  personal: "unread", createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};
const api = {
  getAttentionItems: async () => [item],
  describeAttentionItems: async (keys: string[]) =>
    keys.map(() => "Main yard at the north depot, a long Location name that must truncate"),
  openAttentionItem: async () => ({ url: "https://work.example.test/r/project/location/loc-1" }),
  setAttentionState: async () => {},
};
vi.mock("../../AuthContext", () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }));

let host: HTMLDivElement | undefined, root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

const mount = async () => {
  const router = createRouter({ routeTree: createRootRoute({ component: () => <Toasty><AttentionList /></Toasty> }),
    history: createMemoryHistory({ initialEntries: ["/"] }) });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { await router.load(); root!.render(<RouterProvider router={router} />); });
  await vi.waitFor(() => expect(host!.querySelector("[data-testid=attention-row]")?.textContent).toContain("Main yard"));
};

it("reaches Open from the keyboard and leaves only for the link the server returned", async () => {
  await mount();
  const open = [...host!.querySelectorAll("button")].find(b => b.textContent === "Open")!;
  for (let i = 0; i < 6 && document.activeElement !== open; i++) await userEvent.tab();
  expect(document.activeElement).toBe(open);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(mock.goTo).toHaveBeenCalledExactlyOnceWith(
    "https://work.example.test/r/project/location/loc-1"));
});

it("keeps the row inside its width at desktop and phone sizes, truncating the label", async () => {
  await mount();
  for (const width of [672, 320]) {
    host!.style.width = `${width}px`;
    const row = host!.querySelector<HTMLElement>("[data-testid=attention-row]")!;
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    const label = row.querySelector<HTMLElement>("p")!;
    const actions = row.querySelector<HTMLElement>("button")!.getBoundingClientRect();
    expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(actions.left);
  }
});
