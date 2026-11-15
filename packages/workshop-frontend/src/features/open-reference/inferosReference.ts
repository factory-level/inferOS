/**
 * The canonical InferOps addresses of InferOS resources, as InferMind links to them
 * (`/open/gadget?ref=…`, `/open/blueprint?ref=…`):
 *
 * - `inferops://<company>.<workspace>/inferos/gadget/<workspaceDoId>.<gadgetId>`
 * - `inferops://<company>.<workspace>/inferos/blueprint/<blueprintId>`
 *
 * An address is a locator, never a grant: parsing one only says which native route to open, and
 * that route's own open decides whether the person may see it. So the parser accepts the canonical
 * spelling and nothing else -- no user info, port, query, fragment, percent-escape, extra segment
 * or other kind -- and the caller navigates only to the native route built from its fields.
 */

/** The longest address accepted. */
export const MAX_REFERENCE_LENGTH = 512

export type InferosReferenceKind = 'gadget' | 'blueprint'

export type InferosReference =
  | {
    kind: 'gadget'
    company: string
    workspace: string
    /** The workspace's Overseer Durable Object id: 64 lowercase hex digits. */
    workspaceDoId: string
    /** The gadget's WorkpieceId in that workspace. */
    gadgetId: number
  }
  | {
    kind: 'blueprint'
    company: string
    workspace: string
    blueprintId: string
  }

const LABEL = '[a-z0-9-]{1,63}'
const PREFIX = `^inferops://(${LABEL})\\.(${LABEL})/inferos/`
const GADGET = new RegExp(`${PREFIX}gadget/([0-9a-f]{64})\\.(0|[1-9][0-9]{0,15})$`)
const BLUEPRINT = new RegExp(`${PREFIX}blueprint/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$`)

/** `ref` as an address of `kind`, or null when it is not exactly one. */
export const parseInferosReference = (
  ref: unknown,
  kind: InferosReferenceKind,
): InferosReference | null => {
  if (typeof ref !== 'string' || ref.length > MAX_REFERENCE_LENGTH) return null
  if (kind === 'gadget') {
    const match = GADGET.exec(ref)
    if (!match) return null
    const [, company, workspace, workspaceDoId, id] = match
    const gadgetId = Number(id)
    if (!Number.isSafeInteger(gadgetId)) return null
    return { kind, company, workspace, workspaceDoId, gadgetId }
  }
  const match = BLUEPRINT.exec(ref)
  if (!match) return null
  const [, company, workspace, blueprintId] = match
  return { kind, company, workspace, blueprintId }
}
