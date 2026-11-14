/**
 * InferLab operations: one InferOps Project you were given, and its Locations. Everything you
 * read and request here happens as the person who connected it, with exactly their own InferOps
 * access: what they can't see, you can't see.
 */
import type { RpcTarget } from "cloudflare:workers";

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
 * - `ConnectionExpired`: the connection was revoked or expired; the person must reconnect.
 */
export type InferLabOperationsErrorName =
  | "NotFound"
  | "Forbidden"
  | "StaleRevision"
  | "Conflict"
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
}
