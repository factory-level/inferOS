// Host attention (FAC-237): how a Gadget asks for people's attention without naming them or
// sending them anything, and the per-person projection that results.
//
// The Gadget-facing half is `env.ATTENTION` (attention-binding.d.ts), minted by the overseer's
// binding-loopback dispatch (startGatekeeperSession, target type "attention") for an accepted
// gadget's own code only. Its one method takes an `inferlab.attention-intent` v1: a target
// *reference* and an audience *rule*, never a URL, recipient list or preview. The host:
//
//   1. parses the intent strictly (an extra key, such as `recipients`, `url` or `preview`, is
//      refused, not dropped);
//   2. asks the deployment's AttentionAuthority whether this workspace may raise it at all
//      (the target's company, and the audience's InferLab workspace, for this workspace's owner),
//      and whether its source event is a real committed event matching it (verifyEvent): a Gadget
//      can't make a new item by inventing an event id;
//   3. offers the authority this workspace's own members (owner and build collaborators, by their
//      stable subjects), and keeps only those it says are in the audience and can see the target
//      now;
//   4. hands each recipient's User DO one `inferlab.attention-item` v1, keyed by the contract's
//      attentionItemKey (recipient, source event, reason), so every Gadget observing the same
//      event yields one item per person and a repeated raise changes nothing.
//
// The User DO stores items durably (user-storage `attentionItems`) with the recipient's own
// read state, and checks current visibility again whenever they are read: someone who lost
// access to a target sees no item for it. An item never holds a title or excerpt, so there is
// no preview to leak.
//
// The authority is the one seam to InferLab. With none configured, raising refuses and reading
// returns nothing: nothing is delivered on the host's say-so alone.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { z } from "zod";
import type { GatekeeperSubject } from "@gadgets/workshop-shared/gatekeeper";
import type { AttentionItem, AttentionPersonalState, AttentionTarget } from "@gadgets/workshop-shared/api";
import type { Attention, AttentionIntent } from "./attention-binding";
import { isValidSubject, subjectAccountName } from "./account-subject";

// The contract's uuid rule (inferops `z.uuid()`), as the pinned schema spells it.
const UUID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

/** The name the binding has in a gadget's env. An existing binding of that name shadows it. */
export const ATTENTION_BINDING_NAME = "ATTENTION";

/** The reasons attention may be asked for (`inferlab.attention-intent` v1). */
export const ATTENTION_REASONS = ["review_requested"] as const;

const TargetSchema = z.object({
  v: z.literal(1),
  tenantId: z.string().regex(UUID),
  kind: z.enum(["project/project", "project/location", "knowledge/page", "inferos/gadget", "inferos/blueprint"]),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
}).strict();

// Strict at every level: the contract has no field for recipients, URLs or text, and a key it
// doesn't name is refused rather than silently dropped, so a Gadget can't believe it sent one.
const IntentSchema = z.object({
  v: z.literal(1),
  sourceEventId: z.string().regex(UUID),
  reason: z.enum(ATTENTION_REASONS),
  target: TargetSchema,
  audience: z.object({
    kind: z.literal("permission-holders"),
    workspaceId: z.string().regex(UUID),
    permission: z.string().regex(/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/),
  }).strict(),
}).strict();

/** Parse an attention intent, refusing anything the contract doesn't spell, extra keys included. */
export function parseAttentionIntent(value: unknown): AttentionIntent {
  let parsed = IntentSchema.safeParse(value);
  if (!parsed.success) {
    // Paths only: the refused values are the caller's and stay out of errors and logs.
    let fields = parsed.error.issues.map(issue => issue.path.join(".") || "(intent)");
    throw new Error(`Attention intent refused: ${[...new Set(fields)].join(", ")}.`);
  }
  return parsed.data;
}

/** The contract's dedupe key: recipient, source event and reason, whichever Gadget asked. */
export function attentionItemKey(recipient: GatekeeperSubject,
    intent: Pick<AttentionIntent, "sourceEventId" | "reason">): string {
  return `${subjectAccountName(recipient)}|${intent.sourceEventId}|${intent.reason}`;
}

/**
 * The stable subject an account is named by (the inverse of subjectAccountName), or undefined for
 * an account that isn't keyed on one, such as a password account: attention is addressed to
 * InferLab subjects only.
 */
export function accountSubject(accountName: string): GatekeeperSubject | undefined {
  let match = /^subject~([^~]+)~([^~]+)$/.exec(accountName);
  if (!match) return undefined;
  try {
    let subject = { issuer: decodeURIComponent(match[1]!), subject: decodeURIComponent(match[2]!) };
    return isValidSubject(subject) && subjectAccountName(subject) === accountName ? subject : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The deployment's InferLab authority over attention: the one place that knows who holds what in
 * InferLab and who can see a target. The host never decides either itself. FAC-235 provides the
 * InferOps-backed implementation as the `ATTENTION_AUTHORITY` service binding; without one,
 * attention is unavailable.
 */
export interface AttentionAuthority {
  /**
   * Whether the InferOS workspace `workspace`, owned by `owner`, may raise `intent` at all: its
   * target is in this deployment's company and its audience workspace is one this workspace is
   * bound to.
   */
  approves(workspace: {workspaceId: string; owner: GatekeeperSubject}, intent: AttentionIntent): Promise<boolean>;

  /**
   * Whether `intent` is about a real committed InferLab event. **Every authority must implement
   * this strictly**: true only when a committed event (`inferlab.committed-event`) with eventId
   * `intent.sourceEventId` exists in this deployment's company, its `resource` is `intent.target`
   * (the same tenant, kind and id), its `type` is the event the reason names (`review_requested`:
   * `project.location.review_requested`), and its `workspaceId` is `intent.audience.workspaceId`.
   * False when there is no such event or anything differs; throw when it can't tell. Read with
   * `workspace.owner`'s own InferLab rights, the same as `approves`: a workspace can cite only an
   * event its owner may see.
   *
   * It is what bounds attention: items are keyed by event, so a Gadget can't make a new one by
   * inventing an event id, only by a real committed change, which InferLab guards.
   */
  verifyEvent(workspace: {workspaceId: string; owner: GatekeeperSubject}, intent: AttentionIntent): Promise<boolean>;

  /** Which of `candidates` are in `intent`'s audience and can see its target now. */
  eligible(intent: AttentionIntent, candidates: GatekeeperSubject[]): Promise<GatekeeperSubject[]>;

  /** For each of `targets`, whether `subject` can see it now. Same length and order as `targets`. */
  visible(subject: GatekeeperSubject, targets: AttentionTarget[]): Promise<boolean[]>;

  /**
   * The label to show `subject` for each of `targets`, read now with their own InferLab rights (the
   * record's name), or null when they can't see it or it is gone. Same length and order as
   * `targets`. Throws when it can't tell, so a failure is never shown as "no longer available".
   */
  describe(subject: GatekeeperSubject, targets: AttentionTarget[]): Promise<(string | null)[]>;

  /**
   * Where `subject` opens `target`: the InferWork link InferLab's own resolver builds from its
   * trusted application origins (`resource.resolve`, FAC-229), read with their own rights. Null when
   * they may not open it now. Throws when it can't tell. The host still validates the link
   * (`acceptedInferWorkUrl`); the destination checks access again when it is opened.
   */
  open(subject: GatekeeperSubject, target: AttentionTarget): Promise<{url: string} | null>;
}

/** The longest label shown for an attention item; a longer one is cut. */
export const MAX_ATTENTION_LABEL = 200;

/**
 * A label as it may be shown: a trimmed single line, with control characters removed and at most
 * MAX_ATTENTION_LABEL characters, or null for anything that isn't a non-empty string.
 */
export function cleanAttentionLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Char codes rather than a regex: a control character in a regex literal is a lint error.
  let flat = Array.from(value, ch => {
    let code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0) ? " " : ch;
  }).join("").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length <= MAX_ATTENTION_LABEL ? flat : `${flat.slice(0, MAX_ATTENTION_LABEL - 1)}…`;
}

/**
 * The InferWork origins this deployment opens attention items at, from `INFERWORK_ORIGINS`: a
 * comma-separated list of bare origins (`https://work.example.com`). An entry that isn't a bare
 * http(s) origin is ignored; none configured means no item can be opened.
 */
export function inferWorkOriginsFrom(env: {INFERWORK_ORIGINS?: string}): Set<string> {
  let origins = new Set<string>();
  for (let entry of (env.INFERWORK_ORIGINS ?? "").split(",")) {
    let value = entry.trim();
    try {
      let url = new URL(value);
      if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === value) origins.add(url.origin);
    } catch {
      // Not an origin: ignored.
    }
  }
  return origins;
}

/**
 * `value` as a link the Workshop may send someone to, or null. It must be an absolute http(s) URL
 * with no user info, on one of `origins` exactly. Nothing else about it is trusted: the
 * destination checks access again when it is opened.
 */
export function acceptedInferWorkUrl(value: unknown, origins: ReadonlySet<string>): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return origins.has(url.origin) ? url.href : null;
}

/** The configured authority, or null when this deployment has none (attention is then refused). */
export function attentionAuthorityFrom(env: object): AttentionAuthority | null {
  let binding = (env as {ATTENTION_AUTHORITY?: AttentionAuthority}).ATTENTION_AUTHORITY;
  return binding ?? null;
}

/** What `env.ATTENTION` needs from its workspace. */
export interface AttentionHost {
  /** This workspace's id. */
  readonly workspaceId: string;
  /** The authority, or null when none is configured. */
  attentionAuthority(): AttentionAuthority | null;
  /** The owner's and build collaborators' account names; the first is the owner's. */
  attentionMembers(): Promise<string[]>;
  /** Hand one recipient's item to their User DO; resolves once it is stored. */
  deliverAttention(accountName: string, item: AttentionItem): Promise<void>;
}

/** The `env.ATTENTION` binding. */
@validateRpc()
export class AttentionImpl extends RpcTarget implements Attention {
  constructor(private host: AttentionHost) {
    super();
  }

  async raise(intent: AttentionIntent): Promise<void> {
    let parsed = parseAttentionIntent(intent);
    let authority = this.host.attentionAuthority();
    if (!authority) throw new Error("Attention is unavailable: this deployment has no attention authority.");
    let [ownerName, ...others] = await this.host.attentionMembers();
    let owner = ownerName === undefined ? undefined : accountSubject(ownerName);
    if (!owner) throw new Error("Attention is unavailable: this workspace's owner has no InferLab identity.");
    let workspace = {workspaceId: this.host.workspaceId, owner};
    if (!await authority.approves(workspace, parsed)) {
      throw new Error("Attention refused: this workspace may not raise attention for that target.");
    }
    // A made-up or mismatched event id is refused, so every item stands for a real committed change.
    if (!await authority.verifyEvent(workspace, parsed)) {
      throw new Error("Attention refused: no committed event matches that intent.");
    }
    let members = new Map<string, GatekeeperSubject>();
    for (let name of [ownerName!, ...others]) {
      let subject = accountSubject(name);
      if (subject) members.set(name, subject);
    }
    let eligible = await authority.eligible(parsed, [...members.values()]);
    // Only this workspace's own members, whatever the authority returns: it filters, never adds.
    let recipients = new Set(eligible.map(subject => subjectAccountName(subject))
        .filter(name => members.has(name)));
    let createdAt = new Date().toISOString();
    let results = await Promise.allSettled([...recipients].map(name => {
      let recipient = members.get(name)!;
      return this.host.deliverAttention(name, {
        v: 1,
        itemKey: attentionItemKey(recipient, parsed),
        recipient,
        sourceEventId: parsed.sourceEventId,
        reason: parsed.reason,
        target: parsed.target,
        personal: "unread",
        createdAt,
      });
    }));
    // A raise is idempotent (one item per key, first one kept), so the caller retries a failure.
    let failed = results.filter(result => result.status === "rejected").length;
    if (failed) throw new Error(`Attention was not delivered to ${failed} recipient(s); raise it again.`);
  }
}

/** The personal states a recipient may set on their own item. */
export const ATTENTION_PERSONAL_STATES: readonly AttentionPersonalState[] = ["unread", "read", "dismissed"];
