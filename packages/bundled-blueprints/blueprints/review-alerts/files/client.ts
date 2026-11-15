// ---------------------------------------------------------------------------
// Review Alerts -- the Locations of one InferOps Project that are waiting for
// review. The server reads them live through the PROJECT binding; this side
// only asks it and draws the answer (lib/render.ts).
// ---------------------------------------------------------------------------
import type { GadgetStub } from "./lib/protocol.ts";
import { STYLES, type View, projectLine, renderView } from "./lib/render.ts";

// The RPC stub to this gadget's Durable Object, defined by the Workshop's iframe bootstrap.
declare const gadget: GadgetStub;

const style = document.createElement("style");
style.textContent = STYLES;
document.head.append(style);

const app = document.createElement("main");
app.className = "app";
const head = document.createElement("div");
head.className = "head";
const titles = document.createElement("div");
const heading = document.createElement("h1");
heading.textContent = "Review Alerts";
const project = document.createElement("p");
project.className = "project";
titles.append(heading, project);
const refresh = document.createElement("button");
refresh.type = "button";
refresh.className = "refresh";
refresh.textContent = "Refresh";
head.append(titles, refresh);
const body = document.createElement("section");
body.setAttribute("aria-live", "polite");
app.append(head, body);
document.body.append(app);

function show(view: View): void {
  project.textContent = projectLine(view);
  renderView(body, view);
}

async function load(): Promise<void> {
  refresh.disabled = true;
  show({ state: "loading" });
  try {
    show(await gadget.getReviewAlerts());
  } catch {
    show({ state: "failed", reason: "Unexpected", message: "Couldn't reach this gadget's server. Try again." });
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", () => { void load(); });

// Awaited at the top level so an export captures the list rather than the loading state.
await load();
