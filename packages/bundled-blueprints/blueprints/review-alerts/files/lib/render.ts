// Draws Review Alerts into a root element: one function from what the server answered (or that it
// has not answered yet) to the DOM. Text only ever reaches the page through textContent, so a
// Location's name is shown as written and never parsed as markup.
import type { ReviewAlerts } from "./protocol.ts";

/** What the page shows: the server's answer, or that it is still being read. */
export type View = { state: "loading" } | ReviewAlerts;

export const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 14px; line-height: 1.45;
  background: Canvas; color: CanvasText;
}
.app { max-width: 720px; margin: 0 auto; padding: 20px 16px 32px; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 18px; font-weight: 600; }
.project { margin: 2px 0 0; color: GrayText; font-size: 13px; }
.refresh { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 6px;
  border: 1px solid GrayText; background: transparent; color: inherit; cursor: pointer; }
.refresh:disabled { cursor: default; opacity: .6; }
.state { margin-top: 20px; padding: 16px; border: 1px solid GrayText; border-radius: 8px; }
.state.failed, .state.not-connected { border-style: dashed; }
.state p { margin: 0; }
.state .reason { margin-top: 4px; color: GrayText; font-size: 12px; }
.count { margin: 20px 0 8px; font-weight: 600; }
ul.locations { list-style: none; margin: 0; padding: 0; border: 1px solid GrayText; border-radius: 8px; }
ul.locations li { padding: 10px 14px; overflow-wrap: anywhere; }
ul.locations li + li { border-top: 1px solid GrayText; }
.notice { margin-top: 10px; color: GrayText; font-size: 12px; }
@media (max-width: 480px) { .app { padding: 14px 12px 24px; } h1 { font-size: 16px; } }
@media print {
  :root { color-scheme: light; }
  body { background: #fff; color: #000; }
  .refresh { display: none; }
  ul.locations li { break-inside: avoid; }
}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A bordered message: what a person sees for every state that is not a list. */
function message(kind: string, text: string, detail?: string): HTMLElement {
  const box = el("div", `state ${kind}`);
  box.setAttribute("role", kind === "failed" ? "alert" : "status");
  box.append(el("p", "", text));
  if (detail) box.append(el("p", "reason", detail));
  return box;
}

/** Replaces `body`'s content with `view`. */
export function renderView(body: HTMLElement, view: View): void {
  body.replaceChildren();
  body.setAttribute("aria-busy", String(view.state === "loading"));
  switch (view.state) {
    case "loading":
      body.append(message("loading", "Reading the Project's Locations…"));
      return;
    case "notConnected":
      body.append(message("not-connected", view.message));
      return;
    case "failed":
      body.append(message("failed", view.message, view.reason === "Unexpected" ? undefined : `InferLab operations: ${view.reason}`));
      return;
    case "ready": {
      if (view.waiting.length === 0) {
        body.append(message("empty", "No Locations are waiting for review"));
      } else {
        const count = view.waiting.length === 1 ? "1 Location is waiting for review" : `${view.waiting.length} Locations are waiting for review`;
        body.append(el("p", "count", count));
        const list = el("ul", "locations");
        for (const location of view.waiting) {
          const item = el("li", "", location.name);
          item.dataset.locationId = location.id;
          list.append(item);
        }
        body.append(list);
      }
      if (view.incomplete) {
        body.append(el("p", "notice", "This Project has more Locations than one read covers, so some may be missing."));
      }
      return;
    }
  }
}

/** The line under the heading: which Project this is, once it is known. */
export function projectLine(view: View): string {
  return view.state === "ready" ? `${view.project.name} (${view.project.key})` : "";
}
