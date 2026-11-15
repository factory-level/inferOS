import { createFileRoute, redirect } from '@tanstack/react-router'
import { OpenReferenceRefusal } from '../features/open-reference/OpenReferenceRefusal'
import { parseInferosReference } from '../features/open-reference/inferosReference'

/**
 * Opens a Gadget from its InferOps address (`?ref=inferops://<company>.<workspace>/inferos/gadget/
 * <workspaceDoId>.<gadgetId>`), as InferMind links to it. The address only locates the Gadget: the
 * redirect lands on the native workspace route, whose own open decides who may see it, and shows
 * its own sign-in and access-denied pages. Anything but an exact gadget address is refused here.
 */
export const Route = createFileRoute('/open/gadget')({
  validateSearch: (search: Record<string, unknown>): { ref?: string } =>
    typeof search.ref === 'string' ? { ref: search.ref } : {},
  beforeLoad: ({ search }) => {
    const reference = parseInferosReference(search.ref, 'gadget')
    if (reference?.kind !== 'gadget') return
    throw redirect({
      to: '/workspace/$id',
      params: { id: reference.workspaceDoId },
      search: { w: reference.gadgetId },
      replace: true,
    })
  },
  component: OpenReferenceRefusal,
})
