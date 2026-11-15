// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Route as OpenBlueprintRouteImport } from '../../routes/open.blueprint'
import { Route as OpenGadgetRouteImport } from '../../routes/open.gadget'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom doesn't implement scrolling; the router's scroll restoration calls it on mount.
window.scrollTo = () => {}

const DO_ID = '0123456789abcdef'.repeat(4)
const GADGET_REF = `inferops://grokbot.operations/inferos/gadget/${DO_ID}.7`
const BLUEPRINT_REF = 'inferops://grokbot.operations/inferos/blueprint/inferlab.review-alerts'
const REFUSAL = "This link isn't an InferOS reference InferOS can open"

// The real /open route modules, wired as routeTree.gen.ts wires them, beside stub native routes:
// only where each one sends the browser is under test, not the editor or the landing page.
function makeRouter(initialEntry: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const native = (path: string) => createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <p>native</p>,
  })
  const open = (route: typeof OpenGadgetRouteImport | typeof OpenBlueprintRouteImport, path: string) =>
    route.update({ id: path, path, getParentRoute: () => rootRoute } as never)
  const history = createMemoryHistory({ initialEntries: [initialEntry] })
  return createRouter({
    history,
    routeTree: rootRoute.addChildren([
      native('/workspace/$id'),
      native('/blueprint/$id'),
      native('/'),
      open(OpenGadgetRouteImport, '/open/gadget'),
      open(OpenBlueprintRouteImport, '/open/blueprint'),
    ]),
  })
}

const at = (path: string, ref: string) => `${path}?ref=${encodeURIComponent(ref)}`

describe('opening an InferOS reference', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
  })

  async function renderAt(initialEntry: string) {
    const router = makeRouter(initialEntry)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<RouterProvider router={router} />))
    return router
  }

  it('opens a gadget address in its workspace, replacing the /open entry', async () => {
    const router = await renderAt(at('/open/gadget', GADGET_REF))
    expect(router.state.location.pathname).toBe(`/workspace/${DO_ID}`)
    expect(router.state.location.search).toEqual({ w: 7 })
    expect(router.history.length).toBe(1)
    expect(container!.textContent).toBe('native')
  })

  it('opens a blueprint address on its page', async () => {
    const router = await renderAt(at('/open/blueprint', BLUEPRINT_REF))
    expect(router.state.location.pathname).toBe('/blueprint/inferlab.review-alerts')
    expect(router.state.location.search).toEqual({})
    expect(router.history.length).toBe(1)
  })

  it.each([
    ['no ref', '/open/gadget'],
    ['a blueprint address on the gadget route', at('/open/gadget', BLUEPRINT_REF)],
    ['a gadget address on the blueprint route', at('/open/blueprint', GADGET_REF)],
    ['an address with a query of its own', at('/open/gadget', `${GADGET_REF}?next=/admin`)],
    ['a web address', at('/open/blueprint', 'https://example.com/blueprint/x')],
    ['two refs', `${at('/open/gadget', GADGET_REF)}&ref=${encodeURIComponent(GADGET_REF)}`],
  ])('refuses %s, and goes nowhere', async (_, entry) => {
    const router = await renderAt(entry)
    expect(router.state.location.pathname).toBe(entry.split('?')[0])
    const alert = await vi.waitFor(() => {
      const shown = container!.querySelector('[role=alert]')
      if (!shown) throw new Error('no refusal yet')
      return shown
    }, { timeout: 10_000 })
    expect(alert?.textContent).toContain(REFUSAL)
    expect(alert?.textContent).not.toContain('inferops://')
    expect(container!.querySelector('a')?.getAttribute('href')).toBe('/')
  })
})
