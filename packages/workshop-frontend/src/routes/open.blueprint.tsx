import { createFileRoute, redirect } from '@tanstack/react-router'
import { OpenReferenceRefusal } from '../features/open-reference/OpenReferenceRefusal'
import { parseInferosReference } from '../features/open-reference/inferosReference'

/**
 * Opens a blueprint from its InferOps address (`?ref=inferops://<company>.<workspace>/inferos/
 * blueprint/<blueprintId>`), as InferMind links to it. The address only locates the blueprint: the
 * redirect lands on the native blueprint page, which decides what to show. Anything but an exact
 * blueprint address is refused here.
 */
export const Route = createFileRoute('/open/blueprint')({
  validateSearch: (search: Record<string, unknown>): { ref?: string } =>
    typeof search.ref === 'string' ? { ref: search.ref } : {},
  beforeLoad: ({ search }) => {
    const reference = parseInferosReference(search.ref, 'blueprint')
    if (reference?.kind !== 'blueprint') return
    throw redirect({
      to: '/blueprint/$id',
      params: { id: reference.blueprintId },
      replace: true,
    })
  },
  component: OpenReferenceRefusal,
})
