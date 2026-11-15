// This file declares the type of the attention binding (FAC-237): how a gadget's own code asks for
// people's attention. It is present as `env.ATTENTION` in every gadget's env and in its hooks; the
// agent's executeCode env has none. See attention.ts for what the host does with an intent.

/**
 * What the attention is about: a reference to one record, never its URL. The label and link are
 * read by each viewer, with their own rights, when the item is shown.
 */
export interface AttentionTargetRef {
  v: 1;
  /** The company the record belongs to. */
  tenantId: string;
  kind: "project/project" | "project/location" | "knowledge/page" | "inferos/gadget" | "inferos/blueprint";
  id: string;
}

/**
 * An `inferlab.attention-intent` v1. It names who should look by a rule, holders of `permission`
 * in an InferLab workspace, and never by name: there is no field for a recipient, a URL or text,
 * and an intent carrying one is refused.
 */
export interface AttentionIntent {
  v: 1;
  /** The committed event this is about (`inferlab.committed-event` eventId). */
  sourceEventId: string;
  reason: "review_requested";
  target: AttentionTargetRef;
  audience: {
    kind: "permission-holders";
    /** The InferLab workspace whose permission holders are asked. */
    workspaceId: string;
    /** A permission such as `location:write`. */
    permission: string;
  };
}

/** The `env.ATTENTION` binding. */
export interface Attention {
  /**
   * Ask for attention. The host decides, from InferLab's current view, which of this workspace's
   * members are in the audience and can see the target, and gives each one item. Raising the same
   * intent again, from this gadget or another, changes nothing. Resolves once every recipient's
   * item is stored; on failure, raise it again. Refused when the intent is malformed, carries a key
   * the contract doesn't name, or is for a target or workspace this workspace may not raise
   * attention about, and when the deployment has no attention authority.
   */
  raise(intent: AttentionIntent): Promise<void>;
}
