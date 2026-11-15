// InferLab event ingress and native Gadget Hooks (FAC-236). InferOps (dispatch, FAC-234) delivers
// each committed event, signed, to `POST <BASE_URL>/events/<key>`; a Gadget subscribed through its
// Project binding (`ProjectSession.subscribe`) receives it through the Workshop's own Hook machinery
// (`ApprovalQueue.bindHook`, `HookController`, `HookInitiator`), as every push-driven gatekeeper does.
//
// - Ingress, in this order, each failure a refusal: the destination key names a configured
//   destination (its own secret); the body is at most MAX_EVENT_BYTES; the `v1` signature over the
//   RAW bytes and their timestamp matches, in constant time, within TOLERANCE_SECONDS; only then is
//   the body parsed and checked against `inferlab.committed-event` v1 and FAC-234's envelope; and its
//   scope is the destination's (this deployment's company, the destination's one workspace, this
//   InferLab's issuer, this key).
// - Acknowledged (202) once the deployment's one ProjectEventDriver has durably recorded it: a
//   checkpoint row on the event id and one queued delivery per enabled hook that may watch it, in
//   one transaction. Not when a hook has run: the kit's queue delivers from the driver's alarm and
//   retries. The same event id again (InferOps retries on a timeout) is acknowledged and changes
//   nothing, so a hook fires once.
// - A hook's scope is its binding's (the Project facet's props), captured when it subscribed. The
//   event's own tenant and workspace only select hooks whose binding already has them.
// - At delivery the binding's facet re-reads the Location with the connected person's own token
//   (`ProjectEventDeliveryImpl` in worker.ts): a Location they can't read now, or of another
//   Project, is never delivered. A disabled or deleted hook gets no firing (the Workshop refuses
//   `startHook()`, and disabling drops its queued deliveries); disconnecting drops its hooks.

import { DurableObject, WorkerEntrypoint, type RpcStub, type RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { HookRegistry, type HookCapabilities, type HookDelivery } from "@gadgets/gatekeeper-kit/hook-registry";
import { ResponseTooLargeError, readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";
import { createLogger } from "@gadgets/observability/logger";
import type {
  HookController, HookDescription, HookInitiator, HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";
import { VENDOR_ID } from "./account";
import { type EventDestination, ISSUER_PATTERN, ISSUER_MAX_LENGTH, readConfig, readDestinations, receivesEventsFor } from "./config";
import type { ProjectEventHook, ProjectEventType } from "./types";

type EventLogFields = { vendorId: string; reason: string; destinationKey: string; eventId: string; duplicate: boolean };
const logger = createLogger<EventLogFields>({ component: "gatekeeper.inferlabops.events", vendorId: VENDOR_ID });

/** The headers FAC-234 sends (inferops `domain/ts/dispatch/shared/signature.ts`). */
export const SIGNATURE_HEADER = "x-inferlab-signature";
export const DELIVERY_HEADER = "x-inferlab-delivery";
/** How far a delivery's timestamp may be from this clock, either way: dispatch's default. */
export const TOLERANCE_SECONDS = 300;
/** The largest delivery accepted. A committed event is reference-only, well under a kilobyte. */
export const MAX_EVENT_BYTES = 16 * 1024;
/** How long an accepted event id is remembered: far longer than the signature window replays need. */
export const CHECKPOINT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Why a delivery was refused, logged with the destination key and never with the body. */
export type IngressRefusal =
  | "unknown_destination" | "too_large" | "signature" | "unreadable" | "schema" | "scope";

// ── The contract (`inferlab.committed-event` v1) ───────────────────────────────────────────────

/**
 * The patterns of `scripts/inferlab-contracts/schemas/inferlab.committed-event.v1.schema.json`,
 * copied exactly; a test compares them with the pinned schema so the two can't drift.
 */
export const CONTRACT_PATTERNS = {
  uuid: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
  occurredAt: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
  resourceId: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
  revision: "^\\d+$",
  subject: "^[\\x21-\\x7e]{1,255}$",
  causationKey: "^[A-Za-z0-9_-]{8,128}$",
} as const;

const UUID = new RegExp(CONTRACT_PATTERNS.uuid);
const OCCURRED_AT = new RegExp(CONTRACT_PATTERNS.occurredAt);
const RESOURCE_ID = new RegExp(CONTRACT_PATTERNS.resourceId);
const REVISION = new RegExp(CONTRACT_PATTERNS.revision);
const SUBJECT = new RegExp(CONTRACT_PATTERNS.subject);
const CAUSATION_KEY = new RegExp(CONTRACT_PATTERNS.causationKey);

/** The event types v1 defines; a consumer refuses any other (a new type is a new major). */
export const EVENT_TYPES: readonly ProjectEventType[] = ["project.location.review_requested"];
const RESOURCE_KINDS = ["project/project", "project/location", "knowledge/page", "inferos/gadget", "inferos/blueprint"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

/** Whether `value` is a stable subject (`inferlab.stable-subject` v1). */
function isSubject(value: unknown): boolean {
  if (!isObject(value)) return false;
  const { issuer, subject } = value;
  return typeof issuer === "string" && issuer.length <= ISSUER_MAX_LENGTH && ISSUER_PATTERN.test(issuer)
    && matches(subject, SUBJECT);
}

/** The event's actor (`EventActorSchema`): a user or service account with its subject, or system. */
function isActor(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === "system") return true;
  return (value.type === "user" || value.type === "service_account") && isSubject(value.subject);
}

/**
 * Whether `value` is an `inferlab.committed-event` v1, every required field as the contract states
 * it, and internally consistent (its resource is its tenant's: `eventIsConsistent`).
 */
export function isCommittedEvent(value: unknown): boolean {
  if (!isObject(value)) return false;
  const r = value.resource;
  return value.v === 1
    && matches(value.eventId, UUID)
    && typeof value.type === "string" && (EVENT_TYPES as readonly string[]).includes(value.type)
    && matches(value.occurredAt, OCCURRED_AT)
    && matches(value.tenantId, UUID)
    && matches(value.workspaceId, UUID)
    && isObject(r) && r.v === 1 && matches(r.tenantId, UUID)
    && typeof r.kind === "string" && RESOURCE_KINDS.includes(r.kind) && matches(r.id, RESOURCE_ID)
    && matches(value.resourceRevision, REVISION)
    && isActor(value.actor)
    && matches(value.causationKey, CAUSATION_KEY)
    && r.tenantId === value.tenantId;
}

// ── Ingress ────────────────────────────────────────────────────────────────────────────────────

/** An accepted event as the driver keeps it: what a hook needs, reference-only. */
export type StoredEvent = {
  eventId: string;
  type: ProjectEventType;
  occurredAt: string;
  /** Lowercased, as the binding's props are. */
  tenantId: string;
  workspaceId: string;
  locationId: string;
  revision: string;
};

const encoder = new TextEncoder();

/**
 * Whether `header` holds a `v1` signature of `t=<timestamp>` over `<timestamp>.` followed by the
 * exact `body` bytes, under `secret`, with the timestamp within TOLERANCE_SECONDS of `nowSeconds`.
 * Every candidate is compared, in constant time, so the timing names none.
 */
export async function verifySignature(secret: string, header: string | null, body: Uint8Array,
                                      nowSeconds: number): Promise<boolean> {
  if (!header) return false;
  let timestamp: string | undefined;
  const candidates: string[] = [];
  for (const pair of header.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name === "t" && timestamp === undefined) timestamp = value;
    else if (name === "v1") candidates.push(value);
  }
  if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp) || candidates.length === 0) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const prefix = encoder.encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  let matched = false;
  for (const candidate of candidates) {
    if (!/^[0-9a-f]{64}$/.test(candidate)) continue;
    const given = Uint8Array.from(candidate.match(/../g)!, byte => parseInt(byte, 16));
    matched = crypto.subtle.timingSafeEqual(expected, given) || matched;
  }
  return matched;
}

/**
 * FAC-234's envelope (inferops `CallbackEnvelope`), checked against what this destination is: the
 * event itself, and every scope field equal to this deployment's and this destination's. The
 * payload never chooses a scope; it only fails to match one.
 */
export function parseEnvelope(value: unknown, expected: {
  key: string; issuer: string; tenantId: string; workspaceId: string; deliveryId: string | null;
}): StoredEvent | { refused: "schema" | "scope" } {
  if (!isObject(value) || value.v !== 1 || typeof value.issuer !== "string" || typeof value.destination !== "string"
      || !matches(value.tenantId, UUID) || !matches(value.workspaceId, UUID) || !isCommittedEvent(value.event)) {
    return { refused: "schema" };
  }
  const event = value.event as Record<string, unknown> & { resource: Record<string, unknown> };
  const tenantId = (value.tenantId as string).toLowerCase();
  const workspaceId = (value.workspaceId as string).toLowerCase();
  const inScope = value.issuer === expected.issuer && value.destination === expected.key
    && tenantId === expected.tenantId && workspaceId === expected.workspaceId
    && (event.tenantId as string).toLowerCase() === tenantId
    && (event.workspaceId as string).toLowerCase() === workspaceId;
  if (!inScope) return { refused: "scope" };
  // The delivery header names the event; a mismatch is a request nobody signed as such.
  if (expected.deliveryId !== event.eventId) return { refused: "schema" };
  // The one v1 type is about a Location; anything else under it is not one this hook can describe.
  if (event.resource.kind !== "project/location" || !UUID.test(event.resource.id as string)) {
    return { refused: "schema" };
  }
  return {
    eventId: (event.eventId as string).toLowerCase(),
    type: event.type as ProjectEventType,
    occurredAt: event.occurredAt as string,
    tenantId,
    workspaceId,
    locationId: (event.resource.id as string).toLowerCase(),
    revision: event.resourceRevision as string,
  };
}

const refusal = (status: number, reason: IngressRefusal, key: string | null) => {
  logger.warn("refused an InferLab event delivery", {
    event: "events.ingress.refused", reason, ...(key !== null ? { destinationKey: key } : {}),
  });
  return new Response(null, { status });
};

/** The deployment's one driver. */
export const eventDriver = (exports: Cloudflare.Exports) => exports.ProjectEventDriver.getByName("events");

/**
 * One delivery to `POST <BASE_URL>/events/<key>`. 202 once recorded (a duplicate included); 404 for
 * an unknown key; 413 too large; 401 a bad signature or timestamp; 400 not the contract; 403 not
 * this destination's scope. Nothing is read from the body before its signature is checked.
 */
export async function handleEventDelivery(request: Request, env: Cloudflare.Env, exports: Cloudflare.Exports,
                                          key: string, nowMs = Date.now()): Promise<Response> {
  const config = readConfig(env);
  const destination: EventDestination | undefined = readDestinations(env).get(key);
  if ("off" in config || !destination) return refusal(404, "unknown_destination", null);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_EVENT_BYTES) return refusal(413, "too_large", key);
  let body: Uint8Array;
  try {
    body = await readBytesCapped(request, MAX_EVENT_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return refusal(413, "too_large", key);
    throw error;
  }
  if (!await verifySignature(destination.secret, request.headers.get(SIGNATURE_HEADER), body, Math.floor(nowMs / 1000))) {
    return refusal(401, "signature", key);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return refusal(400, "unreadable", key);
  }
  const parsed = parseEnvelope(payload, {
    key, issuer: config.origin, tenantId: config.tenantId, workspaceId: destination.workspaceId,
    deliveryId: request.headers.get(DELIVERY_HEADER)?.toLowerCase() ?? null,
  });
  if ("refused" in parsed) return refusal(parsed.refused === "scope" ? 403 : 400, parsed.refused, key);
  const { duplicate } = await eventDriver(exports).ingest(parsed);
  logger.info("accepted an InferLab event", {
    event: "events.ingress.accepted", destinationKey: key, eventId: parsed.eventId, duplicate,
  });
  return Response.json({ accepted: true, duplicate }, { status: 202 });
}

// ── Hooks ──────────────────────────────────────────────────────────────────────────────────────

export type ProjectEventHookTarget = RpcTarget & ProjectEventHook;

/** What a hook's delivery stub reaches: its binding's facet, narrowed to delivering. */
export type ProjectEventDelivery = HookDelivery<ProjectEventHookTarget, StoredEvent>;

/**
 * What the driver selects a hook's events by: its binding's own scope, captured when it subscribed;
 * and the connection it was bound through, whose disconnecting drops it.
 */
export type EventRegistration = {
  accountId: string; tenantId: string; workspaceId: string; projectId: string; types: ProjectEventType[];
};

/** Everything a hook needs once enabled, captured when the facet binds it. */
export type ProjectEventHookProps = EventRegistration & { key: string; delivery: RpcStub<ProjectEventDelivery> };

/** Refused when a hook is subscribed where no destination delivers its workspace's events. */
export const EVENTS_NOT_CONFIGURED = "This deployment receives no InferOps events for this workspace.";
const DISCONNECTED = "This InferLab operations connection has been disconnected.";

/** How the Workshop asks the user to approve a hook: by ids only, as descriptions are public. */
export const eventHookDescription = (projectId: string): HookDescription => ({
  title: `Watch InferOps Project ${projectId}`,
  description: "Call this hook when a review is requested for a Location of this Project that the " +
    "connected person can read, letting it read the Location and the Project as them.",
});

/**
 * The hook's controller: a loopback entrypoint, not the facet, since the facet may be deleted in
 * the same turn as the Workshop fires the unawaited `disable()`.
 */
@validateRpc()
export class ProjectEventHookController extends WorkerEntrypoint<Cloudflare.Env, ProjectEventHookProps>
    implements HookController<ProjectEventHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<ProjectEventHookTarget>>, _target: HookTargetMetadata): Promise<void> {
    const { key, delivery, ...registration } = this.ctx.props;
    if (!receivesEventsFor(this.env, registration.workspaceId)) throw new Error(EVENTS_NOT_CONFIGURED);
    await eventDriver(this.ctx.exports).register(key, registration, {
      // @ts-expect-error Worker RPC's mapped types can't relate a stub taking an ApprovalQueue to itself.
      delivery,
      initiator,
    });
  }

  async disable(): Promise<void> {
    await eventDriver(this.ctx.exports).unregister(this.ctx.props.key);
  }
}

const CHECKPOINT_PREFIX = "seen:";
const forgottenKey = (accountId: string) => `forgotten:${accountId}`;

type Capabilities = HookCapabilities<ProjectEventHookTarget, StoredEvent>;

/**
 * The deployment's one driver (`eventDriver`). Its storage: `seen:{eventId}` (the receiver
 * checkpoint, the time accepted), the registry's `reg:`/`caps:` per enabled hook and its queue's
 * rows, and `forgotten:` per disconnected connection.
 */
export class ProjectEventDriver extends DurableObject<Cloudflare.Env> {
  #hooks = new HookRegistry<ProjectEventHookTarget, StoredEvent, EventRegistration>(this.ctx.storage.kv, () => {
    logger.warn("dropped an InferLab event after repeated delivery failures", { event: "events.delivery.dropped" });
  });

  /** Enable hook `key`, unless its connection was disconnected before or while it was approved. */
  async register(key: string, registration: EventRegistration, capabilities: Capabilities): Promise<void> {
    if (this.ctx.storage.kv.get(forgottenKey(registration.accountId)) !== undefined) throw new Error(DISCONNECTED);
    this.ctx.storage.transactionSync(() => this.#hooks.set(key, registration, capabilities));
  }

  /** Disable hook `key`: forget it and end its queued deliveries. */
  async unregister(key: string): Promise<void> {
    this.#hooks.remove(key);
    await this.#reschedule();
  }

  /** Drop every hook of connection `accountId`, and refuse any it enables from now on. */
  async forgetAccount(accountId: string): Promise<void> {
    this.ctx.storage.kv.put(forgottenKey(accountId), Date.now());
    for (const [key, registration] of this.#hooks.entries()) {
      if (registration.accountId === accountId) this.#hooks.remove(key);
    }
    await this.#reschedule();
  }

  /**
   * Record `event` once: its checkpoint and one queued delivery per enabled hook that may watch it,
   * in one transaction, before the delivery is acknowledged. A known event id changes nothing.
   */
  async ingest(event: StoredEvent): Promise<{ duplicate: boolean }> {
    const now = Date.now();
    const checkpoint = CHECKPOINT_PREFIX + event.eventId;
    const queued = this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.kv.get(checkpoint) !== undefined) return null;
      this.ctx.storage.kv.put(checkpoint, now);
      const watching = this.#hooks.entries().filter(([, registration]) => watches(registration, event));
      for (const [key] of watching) this.#hooks.enqueue(key, event.eventId, event, now);
      return watching.length;
    });
    if (queued === null) return { duplicate: true };
    // Due now when queued; otherwise, at least soon enough to forget old checkpoints.
    await this.ctx.storage.setAlarm(queued > 0 ? now : (this.#hooks.nextDue() ?? now + CHECKPOINT_RETENTION_MS));
    return { duplicate: false };
  }

  async alarm(): Promise<void> {
    await this.#hooks.run(Date.now());
    this.#forgetOldCheckpoints(Date.now());
    await this.#reschedule();
  }

  #forgetOldCheckpoints(now: number): void {
    for (const [name, at] of this.ctx.storage.kv.list<number>({ prefix: CHECKPOINT_PREFIX })) {
      if (at < now - CHECKPOINT_RETENTION_MS) this.ctx.storage.kv.delete(name);
    }
  }

  async #reschedule(): Promise<void> {
    const due = this.#hooks.nextDue();
    const hasCheckpoints = this.ctx.storage.kv.list({ prefix: CHECKPOINT_PREFIX, limit: 1 })[Symbol.iterator]().next().done === false;
    if (due !== undefined) await this.ctx.storage.setAlarm(due);
    else if (hasCheckpoints) await this.ctx.storage.setAlarm(Date.now() + CHECKPOINT_RETENTION_MS);
    else await this.ctx.storage.deleteAlarm();
  }
}

/** Whether a hook may watch `event`: its binding's company and workspace, and a type it asked for. */
export function watches(registration: EventRegistration, event: StoredEvent): boolean {
  return registration.tenantId === event.tenantId && registration.workspaceId === event.workspaceId
    && registration.types.includes(event.type);
}

/** Drop the hooks of connection `accountId`, which is disconnecting (`OperationsUser.revoke()`). */
export async function forgetEventHooks(exports: Cloudflare.Exports, accountId: string): Promise<void> {
  await eventDriver(exports).forgetAccount(accountId);
}
