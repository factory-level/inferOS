/**
 * InferLab operations: one InferOps Project you were given, and its Locations. Everything you
 * read and request here happens as the person who connected it, with exactly their own InferOps
 * access: what they can't see, you can't see.
 */
import type { RpcStub, RpcTarget } from "cloudflare:workers";

/** A record's revision: a decimal string. Pass the one you read back when you change the record. */
export type Revision = string;

/** Where a record lives: its company, kind and id. Two records are the same only if all three match. */
export interface ResourceRef {
  v: 1;
  tenantId: string;
  kind: "project/project" | "project/location";
  id: string;
}

/** The Project this connection was given. */
export interface Project {
  ref: ResourceRef;
  /** Short key, such as `PROOF`. */
  key: string;
  name: string;
  revision: Revision;
}

/** A Location of the Project. */
export interface Location {
  ref: ResourceRef;
  /** The Project it belongs to. */
  project: ResourceRef;
  name: string;
  /** `none`: no review asked for. `requested`: a review is waiting. */
  review: { status: "none" | "requested" };
  revision: Revision;
}

/** One page of Locations, in a stable order. Pass `nextCursor` back to get the next page. */
export interface LocationPage {
  items: Location[];
  /** Absent on the last page. */
  nextCursor?: string;
}

/**
 * Errors are thrown as `Error` with one of these `name`s:
 * - `NotFound`: the record doesn't exist, or the connected person can't see it. The two are the
 *   same answer on purpose.
 * - `Forbidden`: the connected person may not do this (for example, an observer requesting a review).
 * - `StaleRevision`: the Location changed since you read it. Read it again and retry.
 * - `Conflict`: a review is already waiting for this Location.
 * - `IdempotencyConflict`: InferOps already used this request's key for a different request, so it
 *   changed nothing.
 * - `ConnectionExpired`: the connection was revoked or expired; the person must reconnect.
 */
export type InferLabOperationsErrorName =
  | "NotFound"
  | "Forbidden"
  | "StaleRevision"
  | "Conflict"
  | "IdempotencyConflict"
  | "ConnectionExpired";

/** One Project, as the connected person sees it. */
export interface ProjectSession extends RpcTarget {
  /** The Project, read now. */
  getProject(): Promise<Project>;

  /**
   * The Project's Locations, `limit` per page (1 to 100, default 50).
   * Pass the previous page's `nextCursor` to continue.
   */
  listLocations(options?: { cursor?: string; limit?: number }): Promise<LocationPage>;

  /** One Location of this Project, read now. `NotFound` if it isn't in this Project. */
  getLocation(locationId: string): Promise<Location>;

  /**
   * Ask for a review of one Location of this Project. Pass the `revision` you read. Reading the
   * Location afterwards shows its review status as `requested`. Asking again for the same Location
   * while a review is waiting is a `Conflict`; a changed Location is a `StaleRevision`.
   */
  requestReview(locationId: string, expectedRevision: Revision): Promise<void>;

  /**
   * Have `hook.receiveEvent()` called with each committed InferOps event on a Location of this
   * Project: today, a review being requested. Each event is checked when it arrives: it reaches the
   * hook only if the person who connected this Project can read that Location now, so a revoked
   * grant or connection stops delivery at once.
   *
   * The hook starts disabled, and nothing is delivered until the user enables it. Every call
   * creates a distinct hook, so subscribe once. An event is delivered once, even when InferOps
   * sends it again. Throws if this deployment receives no InferOps events for this workspace.
   *
   * `hook` must be a persistent stub that restores through a Gadget's `[restore]()` method: inside
   * the Gadget, create it with `this.ctx.restore(params)`. The Gadget's `[restore]()` receives those
   * `params` for every delivery.
   *
   * @example
   * // server.js
   * import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
   * export class Gadget extends DurableObject {
   *   async [restore](params) {
   *     if (params.type === "reviews") return new Reviews(this.env);
   *     throw new TypeError(`Unknown restore type: ${params.type}`);
   *   }
   *   async watch() {
   *     await this.env.INFEROPS_PROJECT.subscribe(await this.ctx.restore({ type: "reviews" }));
   *   }
   * }
   * class Reviews extends RpcTarget {
   *   constructor(env) { super(); this.env = env; }
   *   async receiveEvent(event) {
   *     // Read more as the person, through event.project; raise attention with event.eventId.
   *   }
   * }
   */
  subscribe(hook: RpcStub<ProjectEventHook>): Promise<void>;
}

/** What happened: today, only a review being requested for a Location. */
export type ProjectEventType = "project.location.review_requested";

/** One committed InferOps event on a Location of the Project, as the hook receives it. */
export interface ProjectEvent {
  /** InferOps' id for the event: the same on every delivery of it. Cite it when raising attention. */
  eventId: string;
  type: ProjectEventType;
  /** When it was committed (ISO 8601, UTC). */
  occurredAt: string;
  /** The Location, read when the event arrived, as the connected person sees it. */
  location: Location;
  /** The Location's revision the change produced. The Location as read may be newer. */
  revision: Revision;
  /** The Project, as the connected person: read more, or request reviews, from here. */
  project: ProjectSession;
}

/** What a Gadget implements to receive this Project's events (see `ProjectSession.subscribe`). */
export interface ProjectEventHook extends RpcTarget {
  receiveEvent(event: ProjectEvent): Promise<void>;
}
