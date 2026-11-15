/* =========================================================================
 *  Review Alerts -- the Durable Object
 *  -----------------------------------------------------------------------
 *  Reads one InferOps Project through the PROJECT binding (InferLab
 *  operations) and answers which of its Locations are waiting for review.
 *  It keeps nothing: every call reads InferOps again, as the person who
 *  connected the Project, so what it shows is what that person may see now.
 * ========================================================================= */

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { GadgetEnv, ReadFailure, ReviewAlerts, WaitingLocation } from "./lib/protocol.ts";

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

export class Gadget extends DurableObject<GadgetEnv> {
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
   * How many keys this gadget has stored: always none, because Review Alerts keeps no copy of
   * anything it reads. The instantiation proof reads it to show a fresh gadget starts empty.
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
