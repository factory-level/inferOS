import { beforeEach, describe, expect, it } from "vitest";
import { projectLine, renderView, type View } from "../files/lib/render.ts";

let body: HTMLElement;

beforeEach(() => {
  body = document.createElement("section");
  document.body.replaceChildren(body);
});

const ready = (waiting: { id: string; name: string }[], incomplete = false): View =>
  ({ state: "ready", project: { key: "PROOF", name: "Proof Project" }, waiting, incomplete });

describe("Review Alerts rendering", () => {
  it("shows that it is reading while the server answers", () => {
    renderView(body, { state: "loading" });
    expect(body.textContent).toBe("Reading the Project's Locations…");
    expect(body.getAttribute("aria-busy")).toBe("true");
  });

  it("says it is not connected, with no list", () => {
    renderView(body, { state: "notConnected", message: "Not connected: connect an InferLab operations Project." });
    expect(body.textContent).toBe("Not connected: connect an InferLab operations Project.");
    expect(body.querySelector("ul")).toBeNull();
    expect(body.querySelector("[role=status]")).not.toBeNull();
  });

  it("shows a failure as an alert with the refusal's name", () => {
    renderView(body, { state: "failed", reason: "Forbidden", message: "Not allowed." });
    const alert = body.querySelector("[role=alert]");
    expect(alert?.textContent).toBe("Not allowed.InferLab operations: Forbidden");
    expect(body.querySelector("ul")).toBeNull();
  });

  it("says plainly when nothing is waiting", () => {
    renderView(body, ready([]));
    expect(body.textContent).toBe("No Locations are waiting for review");
    expect(body.querySelector("ul")).toBeNull();
  });

  it("lists each waiting Location by name, as text", () => {
    renderView(body, ready([{ id: "1", name: "North <b>dock</b>" }, { id: "2", name: "Yard" }]));
    expect(body.querySelector(".count")?.textContent).toBe("2 Locations are waiting for review");
    const items = [...body.querySelectorAll("li")];
    expect(items.map(item => item.textContent)).toEqual(["North <b>dock</b>", "Yard"]);
    expect(items.map(item => item.dataset.locationId)).toEqual(["1", "2"]);
    expect(body.querySelector("b")).toBeNull();
    expect(body.getAttribute("aria-busy")).toBe("false");
  });

  it("says when the list may be missing Locations", () => {
    renderView(body, ready([{ id: "1", name: "Yard" }], true));
    expect(body.querySelector(".count")?.textContent).toBe("1 Location is waiting for review");
    expect(body.querySelector(".notice")?.textContent).toContain("some may be missing");
  });

  it("names the Project once it is known", () => {
    expect(projectLine(ready([]))).toBe("Proof Project (PROOF)");
    expect(projectLine({ state: "loading" })).toBe("");
  });
});
