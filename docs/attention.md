# Host attention

A Gadget can ask for people's attention without naming them, messaging them or seeing their
answer (FAC-237). It names a target **reference** and an audience **rule**; the host decides,
from InferLab's current view, who that is among the workspace's own members, and gives each one
item in their "Needs Attention" list. The contracts are InferLab's `inferlab.attention-intent` v1
and `inferlab.attention-item` v1 (pinned in `scripts/inferlab-contracts`).

```mermaid
flowchart LR
  Gadget[Gadget code: env.ATTENTION.raise intent] --> Overseer[Workspace DO]
  Overseer -->|approves? eligible members?| Authority[AttentionAuthority: InferLab]
  Overseer -->|one item per recipient, keyed| User[User DO: attentionItems]
  User -->|visible? at every read| Authority
  User --> Reader[AuthenticatedApi.getAttentionItems / setAttentionState]
```

## Raising: `env.ATTENTION`

`env.ATTENTION` (`packages/workshop-backend/src/attention-binding.d.ts`) is in every gadget's env
and its hooks' env, injected before the gadget's named bindings like `env.GIT`, so an existing
binding named `ATTENTION` still shadows it. The agent's executeCode env has none.

`raise(intent)` is refused unless all of these hold, in this order:

1. **The caller is an accepted gadget's own code**: a gadget or hook caller with a gadget id, for a
   gadget that exists and isn't pending, not running a chat's proposed code
   (`startGatekeeperSession`, target `"attention"`).
2. **The intent is exactly the contract.** The RPC type check (`capnweb-validate`) refuses wrong
   types; `parseAttentionIntent` refuses any key the contract doesn't name. So `recipients`, `url`,
   `preview`, a URL on the target or a list of people in the audience are refused, not dropped.
   Refusals name fields, never values.
3. **An authority is configured** (`env.ATTENTION_AUTHORITY`). Without one, attention is
   unavailable: nothing is ever delivered on the host's say-so alone.
4. **The owner has an InferLab identity**: the workspace owner's account is keyed on a stable
   subject (`account-subject.ts`), which `accountSubject` maps back.
5. **The authority approves** this workspace raising this intent: `approves({workspaceId, owner},
   intent)`. It checks the target's company and that the audience's InferLab workspace is one this
   workspace is bound to.

The host then offers the authority the workspace's **owner and build collaborators** (by stable
subject; use-only collaborators and password accounts are not offered), and the authority returns
those **in the audience who can see the target now** (`eligible`). Anyone it returns who isn't one
of those members is dropped: the authority filters, it never adds. Each recipient's User DO gets
one `AttentionItem` (`attentionRaised`), with a 2-second handoff limit, like unread fanout.

A raise is idempotent, so a failure, or a recipient that didn't take the item, rejects the raise,
and the caller raises it again.

## One item per recipient

The item key is the contract's `attentionItemKey`: the recipient's subject key, the source event and
the reason. It ignores which gadget asked, so every gadget observing the same event, and every
repeat, yields the same key. The User DO keeps the first item for a key and its read state; a
repeat only records the raising workspace too.

## The projection

Items live in the User DO's `attentionItems` collection (`AttentionItemRecord`: the contract item
plus the InferOS workspaces that raised it). It is a new typed-storage collection, so no migration:
existing users have none. Items survive eviction and restart like the rest of the User DO.

- **No preview to leak.** An item holds a reference and a reason, never a title or excerpt; the
  label is read at render time with the viewer's own rights (FAC-238).
- **Current visibility, at every read.** `getAttentionItems()` asks the authority `visible(subject,
  targets)` and returns only items whose target the person can still see, newest first. A revoked
  person sees nothing for it; restored access shows the stored item again with its state. Without an
  authority it returns nothing; when the authority can't tell (it throws), the read rejects rather
  than showing an empty list.
- **Personal state is separate.** `setAttentionState(itemKey, "unread" | "read" | "dismissed")` is
  the person's own and changes nothing in InferLab. An unknown key is ignored.
- **Workspace removal** removes what that workspace alone raised; an item another workspace also
  raised stays.

## The authority

`AttentionAuthority` (`attention.ts`) is the one seam to InferLab, provided as the
`ATTENTION_AUTHORITY` service binding (FAC-235: `gatekeeper-inferlab-ops`, each person's own
InferOps connection, live). Every answer is about a stable subject; the host never decides who
holds what in InferLab, or who can see a record. Until that binding exists, attention is refused.

## Tests

`packages/workshop-backend/__tests__/attention.test.ts`, with a fake authority, covers:

- the binding's presence in a gadget's env and its absence from the agent's;
- caller refusals (agent, user, proposed code, pending and unknown gadgets);
- intent refusals (extra keys, the contract's invalid fixtures, no value echoed);
- the authority's approval;
- candidate selection and the dropping of non-members;
- one item per recipient across gadgets and hooks, with read state kept;
- contract-only fields;
- a revoke between raise and read, and an indeterminate authority;
- durability and read state across eviction;
- misaddressed items, and workspace removal.
