import { Empty, LinkButton } from '@cloudflare/kumo'
import { LinkBreak } from '@phosphor-icons/react'
import { useDocumentTitle } from '../../useDocumentTitle'

const TITLE = "This link isn't an InferOS reference InferOS can open"

/**
 * What `/open/gadget` and `/open/blueprint` show for a `ref` that is not exactly a canonical
 * address of their kind. It names nothing from the link: the address is not echoed back, and the
 * only way on is home.
 */
export const OpenReferenceRefusal = () => {
  useDocumentTitle(TITLE)
  return (
    <div role="alert" className="flex min-h-full items-center justify-center bg-kumo-base px-4 py-12">
      <Empty
        icon={<LinkBreak size={40} aria-hidden="true" />}
        title={TITLE}
        description="Check the link you followed. InferOS opens only the exact address of a Gadget or a blueprint."
        contents={<LinkButton href="/" variant="primary">Go home</LinkButton>}
      />
    </div>
  )
}
