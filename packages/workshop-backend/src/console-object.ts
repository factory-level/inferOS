import { DurableObject } from "cloudflare:workers";

/**
 * Placeholder for the `ConsoleDurableObject` class that migration `v6` declares.
 *
 * The `console-creator` branch (PR #499, ADR 0021) added `v6` and was deployed to dev-os before it
 * reached `main`. Cloudflare refuses a deploy whose migrations omit a tag the live script already
 * applied, so `main` could not be deployed there (error 10074). This class lets `main` carry `v6`
 * without deleting the objects that already exist on dev-os.
 *
 * It does nothing: nothing in `main` reaches it, and it never reads or writes its storage, so any
 * data those objects hold is kept as it is. When #499 lands, its real class replaces this one under
 * the same name; the migration stays as it is here.
 */
export class ConsoleDurableObject extends DurableObject {
  override async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }
}
