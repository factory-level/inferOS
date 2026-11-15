// What Review Alerts' client and server share: the part of the InferLab operations API the server
// calls, and the one answer it gives the client. Imported type-only on both sides, so none of it
// ships.

/**
 * The InferLab operations session this gadget reads, as `env.PROJECT` presents it: the methods of
 * `ProjectSession` in `packages/gatekeeper-inferlabops/src/types.d.ts` that Review Alerts calls,
 * with the fields of their results it uses. Everything it reads happens as the person who
 * connected the Project, with their own InferOps access.
 */
export interface ProjectSession {
  getProject(): Promise<{ key: string; name: string }>;
  listLocations(options?: { cursor?: string; limit?: number }): Promise<{
    items: { ref: { id: string }; name: string; review: { status: "none" | "requested" } }[];
    nextCursor?: string;
  }>;
}

/** The bindings the gadget's Durable Object receives. `PROJECT` is absent until one is connected. */
export interface GadgetEnv {
  PROJECT?: ProjectSession;
}

/** A Location of the Project that is waiting for review. */
export interface WaitingLocation {
  id: string;
  name: string;
}

/**
 * Why a read of the Project failed. The first six are the names InferLab operations documents for
 * its errors; `Unexpected` is anything else.
 */
export type ReadFailure =
  | "NotFound"
  | "Forbidden"
  | "ConnectionExpired"
  | "StaleRevision"
  | "Conflict"
  | "IdempotencyConflict"
  | "Unexpected";

/**
 * The Locations waiting for review, read live from InferOps on every call. Nothing of it is kept
 * by the gadget: InferOps is the record.
 *
 * - `notConnected`: no Project is bound. This is never shown as an empty list.
 * - `failed`: InferLab operations refused or could not answer; `message` says which, for a person.
 * - `ready`: the Project and its waiting Locations, possibly none. `incomplete` is true when the
 *   Project has more Locations than one read pages through, so the list may be missing some.
 */
export type ReviewAlerts =
  | { state: "notConnected"; message: string }
  | { state: "failed"; reason: ReadFailure; message: string }
  | {
    state: "ready";
    project: { key: string; name: string };
    waiting: WaitingLocation[];
    incomplete: boolean;
  };

/** The gadget's RPC surface, as the client's `gadget` stub reaches it. */
export interface GadgetStub {
  getReviewAlerts(): Promise<ReviewAlerts>;
}
