// InferOps, as the two InferLab gatekeepers reach it from the integration harness (FAC-236): the
// central-auth token exchange for sign-in (gatekeeper-inferlab) and for a person's operations
// connection (gatekeeper-inferlabops), and the reads they make with that person's token. A handler
// module for the harness's NetworkInterceptor, with one company, one workspace, one Project and one
// Location, and grants the test can revoke.

import { createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import type { GatekeeperSpec, Harness } from "../src/harness.js";
import type { Handler } from "../src/network-interceptor.js";
import { listConnectedAccounts, waitFor } from "../src/rpc-client.js";

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const ORIGIN = "https://auth.inferops.test";
export const COMPANY = "00000000-0000-4000-8000-000000000001";
export const WS = "00000000-0000-4000-8000-000000000011";
export const PROJECT = "00000000-0000-4000-8000-00000000a201";
export const LOC = "00000000-0000-4000-8000-00000000a211";
export const OWNER = "00000000-0000-4000-8000-000000000103";
export const ADDRESS = `inferops://acme.operations/project/project/${PROJECT}`;
export const DESTINATION = "inferos-field-ops";
const SECRET = "integration-secret-0123456789abcdef0123456789";
export const SIGN_IN_WORKER = "gatekeeper-inferlab";
export const OPS_WORKER = "gatekeeper-inferlabops";
const SIGN_IN_BASE = "https://workshop.test/gatekeeper/inferlab";
export const OPS_BASE = "https://workshop.test/gatekeeper/inferlabops";

const shared = { INFERLAB_AUTH_ORIGIN: ORIGIN, INFEROPS_COMPANY: COMPANY };

/** InferLab sign-in (FAC-214), against this fake. */
export const signInGatekeeper = (): GatekeeperSpec => ({
  binding: "INFERLAB",
  dir: resolve(PACKAGES, "gatekeeper-inferlab"),
  patch: config => { config.vars = { ...config.vars, ...shared, BASE_URL: SIGN_IN_BASE }; },
});

/** InferLab operations (FAC-235/236), with one event destination for the workspace. */
export const operationsGatekeeper = (): GatekeeperSpec => ({
  binding: "INFERLABOPS",
  dir: resolve(PACKAGES, "gatekeeper-inferlabops"),
  patch: config => {
    config.vars = {
      ...config.vars, ...shared, BASE_URL: OPS_BASE,
      INFERLAB_EVENT_DESTINATIONS: JSON.stringify([{ key: DESTINATION, workspaceId: WS, secret: SECRET }]),
    };
  },
});

/** The Workshop's side: sign-in by subject at this issuer, and the attention authority. */
export function patchWorkshop(config: { vars?: Record<string, unknown>; services?: { binding: string; service: string; entrypoint?: string }[] }) {
  config.vars = { ...config.vars, AUTH_GATEKEEPERS: "inferlab", AUTH_GATEKEEPER_ISSUERS: `inferlab=${ORIGIN}` };
  config.services = [...config.services ?? [],
    { binding: "ATTENTION_AUTHORITY", service: OPS_WORKER, entrypoint: "InferLabAttentionAuthority" }];
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = () => json({ error: { code: "NOT_FOUND" } }, 404);
const jwt = () => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).toString("base64url")}.s`;

export class FakeInferOps {
  /** The owner's InferOps grant in the workspace; revoking it refuses their next read. */
  granted = true;
  /** Events InferOps committed, by id: what `verifyEvent` reads back. */
  readonly events = new Map<string, Record<string, unknown>>();
  /** Every request, as `METHOD path`. */
  readonly requests: string[] = [];
  #tokens = new Set<string>();
  #minted = 0;

  readonly handler: Handler = async (url, method, headers, request) => {
    if (url.origin !== ORIGIN) return null;
    this.requests.push(`${method} ${url.pathname}`);
    if (url.pathname === "/auth/token" && method === "POST") {
      await request.text();
      const token = `${jwt()}.owner.${++this.#minted}`;
      this.#tokens.add(token);
      return json({ token, refreshToken: `iexr_owner_${this.#minted}`,
        user: { id: OWNER, email: "owner@acme.example", emailVerified: true, tenantId: COMPANY } });
    }
    if (url.pathname === "/auth/refresh" && method === "POST") {
      const token = `${jwt()}.owner.${++this.#minted}`;
      this.#tokens.add(token);
      return json({ token, refreshToken: `iexr_owner_${this.#minted}` });
    }
    if (url.pathname === "/auth/logout") return new Response(null, { status: 204 });
    const bearer = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!this.#tokens.has(bearer)) return json({ error: { code: "UNAUTHORIZED" } }, 401);
    if (url.pathname === "/auth/company") {
      return json({ tenantId: COMPANY, slug: "acme", principalId: OWNER,
        workspaces: [{ workspaceId: WS, workspaceName: "Operations", product: "inferops", role: "member" }] });
    }
    if (url.pathname === "/workspaces") {
      return json([{ id: WS, tenant_id: COMPANY, product: "inferops", name: "Operations", slug: "operations" }]);
    }
    if (!this.granted || headers.get("x-workspace-id") !== WS) return json({ error: { code: "FORBIDDEN" } }, 403);
    if (url.pathname === "/auth/permissions") {
      const permission = url.searchParams.get("permissions") ?? "";
      return json({ workspaceId: WS, role: "member", assumed: false, primaryRole: null, roleAllows: [], roleDenies: [],
        deniedPermissions: [], decisions: [{ permission, allowed: true, reason: "role-allow" }] });
    }
    const ref = (kind: string, id: string) => ({ v: 1, tenantId: COMPANY, kind, id });
    if (url.pathname === `/project/projects/${PROJECT}`) {
      return json({ v: 1, ref: ref("project/project", PROJECT), key: "PROOF", name: "Proof", revision: "7" });
    }
    if (url.pathname === `/project/locations/${LOC}`) {
      return json({ v: 1, ref: ref("project/location", LOC), project: ref("project/project", PROJECT),
        name: "Main yard", review: { status: "requested" }, revision: "4" });
    }
    const event = /^\/project\/locations\/[0-9a-f-]+\/events\/([0-9a-f-]+)$/.exec(url.pathname)?.[1];
    if (event) return this.events.has(event) ? json(this.events.get(event)) : notFound();
    return notFound();
  };

  /** Commit a review request on the Location, as InferOps would; returns the committed event. */
  commit(eventId: string): Record<string, unknown> {
    const event = {
      v: 1, eventId, type: "project.location.review_requested", occurredAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      tenantId: COMPANY, workspaceId: WS, resource: { v: 1, tenantId: COMPANY, kind: "project/location", id: LOC },
      resourceRevision: "4", actor: { type: "user", subject: { issuer: ORIGIN, subject: OWNER } }, causationKey: `review-${eventId.slice(-8)}`,
    };
    this.events.set(eventId, event);
    return event;
  }

  /**
   * Deliver `event` to the gatekeeper's ingress as InferOps' dispatch does (FAC-234): the envelope,
   * signed `t=…,v1=…` over `<t>.<body>` with the destination's secret.
   */
  async deliver(harness: Harness, event: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const body = JSON.stringify({ v: 1, issuer: ORIGIN, destination: DESTINATION, tenantId: COMPANY, workspaceId: WS, event });
    const t = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
    const response = await harness.fetchWorker(OPS_WORKER, `${OPS_BASE}/events/${DESTINATION}`, {
      method: "POST", body,
      headers: { "content-type": "application/json", "x-inferlab-event": String(event.type),
        "x-inferlab-delivery": String(event.eventId), "x-inferlab-signature": `t=${t},v1=${signature}` },
    });
    return { status: response.status, body: response.status === 202 ? await response.json() : null };
  }

  /** How many times `verifyEvent` read event `eventId`: once per raise that cites it. */
  verifyReads(eventId: string): number {
    return this.requests.filter(r => r.endsWith(`/events/${eventId}`)).length;
  }
}

/** The handoff page's ticket, as the kit's `connectHandoffPageHtml` embeds it. */
async function ticketOf(page: { status: number; text(): Promise<string> }): Promise<string> {
  const ticket = /var ticket = (".*?");\n/.exec(await page.text());
  if (!ticket) throw new Error(`The handoff page (HTTP ${page.status}) carried no ticket`);
  return JSON.parse(ticket[1]!) as string;
}

/** Follow a gatekeeper's connect link through InferLab's `/authorize` back to its `/oauth`. */
async function throughOAuth(harness: Harness, worker: string, base: string, url: string): Promise<string> {
  const begun = await harness.fetchWorker(worker, url, { redirect: "manual" });
  if (begun.status !== 302) throw new Error(`The connect link answered ${begun.status}`);
  const state = new URL(begun.headers.get("Location")!).searchParams.get("state")!;
  return ticketOf(await harness.fetchWorker(worker, `${base}/oauth?code=owner&state=${encodeURIComponent(state)}`));
}

/** Sign the owner in by their InferLab subject (gatekeeper-inferlab), as the sign-in popup would. */
export async function signInOwner(harness: Harness, pub: RpcStub<PublicApi>): Promise<RpcStub<AuthenticatedApi>> {
  const { url, nonce, attempt } = await pub.startGatekeeperLogin("inferlab");
  await pub.confirmLogin(await throughOAuth(harness, SIGN_IN_WORKER, SIGN_IN_BASE, url), nonce);
  const token = await waitFor("the sign-in token", async () => await attempt.receive());
  return await pub.authenticate(token);
}

/** Connect the owner's own InferLab operations account (gatekeeper-inferlabops). */
export async function connectOperations(harness: Harness, api: RpcStub<AuthenticatedApi>) {
  const { url, nonce } = await api.connectAccount("inferlabops");
  await api.completeConnectHandoff(await throughOAuth(harness, OPS_WORKER, OPS_BASE, url), nonce);
  return await waitFor("the connected InferLab operations account", async () =>
    (await listConnectedAccounts(api)).find(account => account.vendorId === "inferlabops") ?? null);
}
