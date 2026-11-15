/* =========================================================================
 *  Review Alerts -- the Durable Object
 *  -----------------------------------------------------------------------
 *  Reads one InferOps Project through the PROJECT binding (InferLab
 *  operations) and answers which of its Locations are waiting for review.
 *  It keeps nothing of InferOps: every call reads InferOps again, as the
 *  person who connected the Project, so what it shows is what that person
 *  may see now.
 *
 *  Watching (FAC-239): `watchReviews()` subscribes one persistent hook to the
 *  Project's committed events. The person turns it on in Activity; each review
 *  requested then raises a Needs attention item through the host's attention
 *  capability, citing InferOps' event id, for the holders of `location:write`
 *  in that workspace. The only thing stored is that the hook was made.
 * ========================================================================= */

import { DurableObject, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";
import type {
  Attention, GadgetEnv, ReadFailure, ReviewAlerts, ReviewEvent, WaitingLocation, WatchState,
} from "./lib/protocol.ts";

// workerd's persistent-stub symbol, which the stock Workers types don't declare yet.
declare module "cloudflare:workers" {
  export const restore: unique symbol;
}

/** The restore parameters of this gadget's one hook. */
const HOOK = { type: "review-alerts" } as const;

/** The storage key recording that the hook was made, so a second watch makes no second hook. */
const WATCHING_KEY = "watching";

/**
 * Who a review alert is for: the people who may act on the Location. Not exported: a gadget's
 * module exports only its entrypoints (workerd refuses any other value, and the worker won't start).
 */
const ALERT_PERMISSION = "location:write";

const WATCHING = "Watching for reviews. Turn the hook on in Activity to be alerted.";
const NO_EVENTS = "This InferOS doesn't receive InferOps events for that workspace, so it can't watch for reviews.";

/** Locations asked for per page: the most InferLab operations returns at once. */
const PAGE_SIZE = 100;

/** Pages read before giving up on the rest, so one read stays bounded however large the Project. */
const MAX_PAGES = 20;

const NOT_CONNECTED = "Not connected: connect an InferLab operations Project.";

/** What a person is told for each way a read can fail. Never the error's own text. */
const FAILURE_MESSAGES: Record<ReadFailure, string> = {
  NotFound: "This Project wasn't found, or the person who connected it can no longer see it.",
  Forbidden: "The person who connected this Project may not read its Locations.",
  ConnectionExpired: "The InferLab operations connection expired or was revoked. Reconnect it to see review alerts.",
  StaleRevision: "The Project changed while it was being read. Try again.",
  Conflict: "InferLab operations reported a conflict while reading this Project. Try again.",
  IdempotencyConflict: "InferLab operations refused the read. Try again.",
  Unexpected: "Couldn't read this Project from InferLab operations. Try again.",
};

const KNOWN_FAILURES = new Set<string>(Object.keys(FAILURE_MESSAGES));

/** The documented failure an error names, or `Unexpected`. */
export function failureOf(error: unknown): ReadFailure {
  const name = error instanceof Error ? error.name : undefined;
  return name !== undefined && KNOWN_FAILURES.has(name) ? name as ReadFailure : "Unexpected";
}

/** The hook InferOps' events reach: one alert per review requested, citing the event. */
class ReviewHook extends RpcTarget {
  readonly #attention: Attention | undefined;

  constructor(attention: Attention | undefined) {
    super();
    this.#attention = attention;
  }

  async receiveEvent(event: ReviewEvent): Promise<void> {
    if (!this.#attention) throw new Error("Attention is unavailable to this gadget.");
    await this.#attention.raise({
      v: 1,
      sourceEventId: event.eventId,
      reason: "review_requested",
      target: event.location.ref,
      audience: { kind: "permission-holders", workspaceId: event.workspaceId, permission: ALERT_PERMISSION },
    });
  }
}

export class Gadget extends DurableObject<GadgetEnv> {
  /** Every delivery of the hook `watchReviews()` made comes back through here. */
  async [restore](params: { type?: string }): Promise<ReviewHook> {
    if (params?.type !== HOOK.type) throw new TypeError(`Unknown restore type: ${String(params?.type)}`);
    return new ReviewHook(this.env.ATTENTION);
  }

  /**
   * Makes this gadget's hook on the bound Project's events, once. It starts disabled: the person
   * turns it on in Activity. A second call makes no second hook.
   */
  async watchReviews(): Promise<WatchState> {
    const session = this.env.PROJECT;
    if (!session) return { state: "notConnected", message: NOT_CONNECTED };
    if (await this.ctx.storage.get(WATCHING_KEY)) return { state: "watching", created: false, message: WATCHING };
    try {
      await session.subscribe(await this.ctx.restore(HOOK));
    } catch (error) {
      const reason = failureOf(error);
      return { state: "failed", message: reason === "Unexpected" ? NO_EVENTS : FAILURE_MESSAGES[reason] };
    }
    await this.ctx.storage.put(WATCHING_KEY, true);
    return { state: "watching", created: true, message: WATCHING };
  }

  /** The bound Project's Locations that are waiting for review, read now. */
  async getReviewAlerts(): Promise<ReviewAlerts> {
    const session = this.env.PROJECT;
    if (!session) return { state: "notConnected", message: NOT_CONNECTED };

    try {
      const project = await session.getProject();
      const waiting: WaitingLocation[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await session.listLocations(cursor === undefined ? { limit: PAGE_SIZE } : { cursor, limit: PAGE_SIZE });
        pages++;
        for (const location of page.items) {
          if (location.review.status === "requested") waiting.push({ id: location.ref.id, name: location.name });
        }
        cursor = page.nextCursor;
        // A cursor handed back twice would page forever; what was read so far is still shown.
        if (cursor !== undefined && seen.has(cursor)) break;
        if (cursor !== undefined) seen.add(cursor);
      } while (cursor !== undefined && pages < MAX_PAGES);

      return {
        state: "ready",
        project: { key: project.key, name: project.name },
        waiting,
        incomplete: cursor !== undefined,
      };
    } catch (error) {
      const reason = failureOf(error);
      return { state: "failed", reason, message: FAILURE_MESSAGES[reason] };
    }
  }

  /**
   * How many keys this gadget has stored: none of what it reads, because Review Alerts keeps no
   * copy of InferOps; only the marker that its hook was made, once `watchReviews()` made it. The
   * instantiation proof reads it to show a fresh gadget starts empty.
   */
  async storedKeyCount(): Promise<number> {
    return (await this.ctx.storage.list()).size;
  }
}

/** Only a PDF of what is on screen: the list lives in InferOps, so there is no file of its own. */
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats() {
    return [{
      id: "pdf",
      label: "PDF",
      mode: "browser",
      contentType: "application/pdf",
      fileExtension: ".pdf",
    }];
  }
}
