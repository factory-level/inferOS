// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import { AUTH_ERROR_CODES, AUTH_ERROR_MESSAGES, SIGN_OUT_ERROR_CODES, createAuthError, createSignOutError, type PublicApi, type AuthenticatedApi, type AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { setReportedUserId } from './errorReporting'
import { useAuth } from './useAuth'
import { nativeConnectCompletion } from './features/native-app/connectSession'
import { disconnectNativeNotificationEnrollment } from './features/notifications/nativeNotificationEnrollment'
import SignOutWarning, { SIGN_OUT_WARNINGS } from './features/auth/SignOutWarning'

vi.mock('./errorReporting', () => ({
  setReportedUserId: vi.fn<(reportedUserId: string | undefined) => void>(),
}))
vi.mock('./features/notifications/nativeNotificationEnrollment', () => ({
  disconnectNativeNotificationEnrollment: vi.fn<() => void>(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const person: AiChatAuthorInfo = { type: 'user', id: 'person@example.com', name: 'Person' }

/** A public API whose authenticated stub resolves `whoami` to `author`, or rejects without one. */
function stubPublicApi(author?: AiChatAuthorInfo): RpcStub<PublicApi> {
  const authenticated = {
    onRpcBroken: () => {},
    whoami: async () => {
      if (!author) throw new Error('session gone')
      return author
    },
    amIAdmin: async () => false,
    [Symbol.dispose]: () => {},
  }
  return {
    authenticate: () => authenticated,
    authenticateFromCfAccess: () => authenticated,
  } as unknown as RpcStub<PublicApi>
}

/**
 * A public API whose `whoami` stays pending until released, for the window in which an answer can
 * arrive after a logout or a newer authentication has superseded it.
 *
 * Each authentication gets its own deferred, so `release(nth, ...)` can answer an earlier lookup
 * after a later one — the ordering a shared promise could not express.
 */
function deferredPublicApi(): {
  api: RpcStub<PublicApi>
  release: (nth: number, author: AiChatAuthorInfo) => void
} {
  const releases: ((author: AiChatAuthorInfo) => void)[] = []
  const authenticate = () => {
    let release: (author: AiChatAuthorInfo) => void = () => {}
    const pending = new Promise<AiChatAuthorInfo>((resolve) => { release = resolve })
    releases.push(release)
    return { whoami: () => pending, onRpcBroken: () => {}, [Symbol.dispose]: () => {} }
  }
  return {
    api: { authenticate, authenticateFromCfAccess: authenticate } as unknown as RpcStub<PublicApi>,
    release: (nth, author) => releases[nth](author),
  }
}

type Controls = { login: (token: string) => void; logout: () => Promise<void> }

describe('useAuth error reporting identity', () => {
  const roots: Root[] = []
  const containers: HTMLDivElement[] = []

  afterEach(() => {
    act(() => roots.forEach(root => root.unmount()))
    roots.length = 0
    containers.forEach(container => container.remove())
    containers.length = 0
    localStorage.clear()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  /** Mounts an independent `useAuth` instance, returning its login/logout handles. */
  async function mount(
    publicApi: RpcStub<PublicApi>,
    hook: typeof useAuth = useAuth,
  ): Promise<{ controls: Controls; root: Root }> {
    const captured: { controls?: Controls } = {}
    function Consumer() {
      const { login, logout } = hook(publicApi)
      captured.controls = { login, logout }
      return null
    }

    const container = document.createElement('div')
    document.body.append(container)
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<Consumer />))
    return { controls: captured.controls!, root }
  }

  it('names the user when a stored token authenticates on mount', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi(person))

    expect(setReportedUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('names the user after an inline login with no provider mounted', async () => {
    // The public blueprint page renders outside AuthProvider and logs in through its own useAuth
    // instance. Attaching identity in the provider left that whole session reporting anonymously.
    const { controls } = await mount(stubPublicApi(person))
    expect(setReportedUserId).not.toHaveBeenCalled()

    await act(async () => controls.login('fresh-token'))

    expect(setReportedUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('names the user when CF Access authenticates without a token', async () => {
    vi.stubEnv('VITE_CF_ACCESS_MODE', 'true')
    vi.resetModules()
    // Both imports must come from the reset registry, or the assertion would watch a mock instance
    // that the freshly imported hook never calls.
    const { setReportedUserId: setId } = await import('./errorReporting')
    const { useAuth: cfAccessUseAuth } = await import('./useAuth')

    await mount(stubPublicApi(person), cfAccessUseAuth)

    expect(setId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('keeps the identity when one instance unmounts while another stays mounted', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const api = stubPublicApi(person)
    await mount(api)
    const { root: inner } = await mount(api)

    // The blueprint page nests its own instance inside the root's. Clearing on unmount would let
    // navigating away from that page blank an identity the root still holds.
    act(() => inner.unmount())
    roots.splice(roots.indexOf(inner), 1)

    expect(setReportedUserId).not.toHaveBeenCalledWith(undefined)
  })

  it('clears the identity on logout', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { controls } = await mount(stubPublicApi(person))

    act(() => { void controls.logout() })

    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)
  })

  it('disconnects native push enrollment and ends the native session on CFOS logout', async () => {
    const sessionEnded = vi.fn<() => void>()
    vi.stubGlobal('cloudflareOSNative', {
      version: 1, isAvailable: () => true, loginReady: () => {}, returnToInstalls: () => {}, sessionEnded,
    })
    localStorage.setItem('authToken', 'stored-token')
    const { controls } = await mount(stubPublicApi(person))
    act(() => { void controls.logout() })
    expect(disconnectNativeNotificationEnrollment).toHaveBeenCalledOnce()
    expect(sessionEnded).toHaveBeenCalledOnce()
  })

  it.each(['disconnect', 'session-ended'] as const)('finishes local logout when the native %s callback throws', async callback => {
    using _ = vi.spyOn(console, 'error').mockImplementation(() => {})
    localStorage.setItem('authToken', 'stored-token')
    vi.stubGlobal('cloudflareOSNative', {
      version: 1, isAvailable: () => true, loginReady: () => {}, returnToInstalls: () => {},
      sessionEnded: () => { if (callback === 'session-ended') throw new Error('native bridge unavailable') },
    })
    if (callback === 'disconnect') vi.mocked(disconnectNativeNotificationEnrollment)
      .mockImplementationOnce(() => { throw new Error('native bridge unavailable') })
    const { controls } = await mount(stubPublicApi(person))
    act(() => { void controls.logout() })
    expect(disconnectNativeNotificationEnrollment).toHaveBeenCalledOnce()
    expect(localStorage.getItem('authToken')).toBeNull()
    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)
  })

  it('ignores a lookup that resolves after logout', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, release } = deferredPublicApi()
    const { controls } = await mount(api)

    act(() => { void controls.logout() })
    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)

    // Disposing the stub is not a defence: capnweb does not guarantee that disposal rejects a call
    // already in flight, so a slow lookup could otherwise name a user who has just signed out.
    await act(async () => release(0, person))

    expect(setReportedUserId).not.toHaveBeenCalledWith('person@example.com')
    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)
  })

  it('ignores a lookup superseded by a newer authentication', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, release } = deferredPublicApi()
    const { controls } = await mount(api)
    await act(async () => controls.login('fresh-token'))

    // The newer authentication supersedes the first lookup, so answering that one last must not let
    // it win. Only the generation distinguishes them; arrival order alone would pick the stale id.
    await act(async () => release(0, { ...person, id: 'stale@example.com' }))
    expect(setReportedUserId).not.toHaveBeenCalledWith('stale@example.com')

    await act(async () => release(1, person))
    expect(setReportedUserId).toHaveBeenLastCalledWith('person@example.com')
  })

  it('does not name a person for an author that is not a user account', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi({ type: 'agent', id: 'gpt-5.1-pro', name: 'GPT' }))

    expect(setReportedUserId).not.toHaveBeenCalled()
  })

  it('names nobody when the identity lookup fails', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi())

    expect(setReportedUserId).not.toHaveBeenCalled()
  })

  it('keeps a native connect attached to this hook when its public RPC is replaced', async () => {
    const connection = () => {
      const completeConnectHandoff = vi.fn<(ticket: string, nonce: string) => Promise<void>>().mockResolvedValue(undefined)
      const authenticated = { whoami: async () => person, completeConnectHandoff,
        onRpcBroken: () => {}, [Symbol.dispose]: () => {} }
      const api = { authenticate: () => authenticated } as unknown as RpcStub<PublicApi>
      return { api, completeConnectHandoff }
    }
    const first = connection(), next = connection()
    localStorage.setItem('authToken', 'stored-token')
    let current: RpcStub<AuthenticatedApi> | null = null
    const Consumer = ({ api }: { api: RpcStub<PublicApi> }) => {
      current = useAuth(api).authenticatedApi
      return null
    }
    const container = document.createElement('div')
    document.body.append(container)
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<Consumer api={first.api} />))
    const complete = nativeConnectCompletion(current!, 'b'.repeat(64))
    await act(async () => root.render(<Consumer api={next.api} />))
    await complete('a'.repeat(64), new AbortController().signal)
    expect(first.completeConnectHandoff).not.toHaveBeenCalled()
    expect(next.completeConnectHandoff).toHaveBeenCalledExactlyOnceWith('a'.repeat(64), 'b'.repeat(64))
  })
})

// FAC-300: signing out ends the session on the server, not only in this browser.

/** A public API whose authenticated stub records `signOut` and disposal, in order. */
function signOutApi(signOut: () => Promise<void>) {
  const events: string[] = []
  const authenticated = {
    onRpcBroken: () => {},
    whoami: async () => person,
    signOut: () => { events.push('signOut'); return signOut() },
    [Symbol.dispose]: () => { events.push('dispose') },
  }
  const api = { authenticate: () => authenticated } as unknown as RpcStub<PublicApi>
  return { api, events }
}

describe('useAuth sign-out', () => {
  const roots: Root[] = []
  const PROVIDER = SIGN_OUT_WARNINGS.provider.title
  const UNCONFIRMED = SIGN_OUT_WARNINGS.unconfirmed.title
  type SignOutControls = { login: (token: string) => void; logout: () => Promise<void> }

  afterEach(() => {
    act(() => roots.forEach(root => root.unmount()))
    roots.length = 0
    document.body.replaceChildren()
    localStorage.clear()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  /** Renders the warning as the sign-in page does, after the signed-in state. */
  async function mountWith(api: RpcStub<PublicApi>): Promise<SignOutControls> {
    const captured: { controls?: SignOutControls } = {}
    function Consumer() {
      const { login, logout, isAuthenticated, signOutWarning, dismissSignOutWarning } = useAuth(api)
      useEffect(() => { captured.controls = { login, logout } })
      return <>
        <p>{isAuthenticated ? 'Signed in' : 'Signed out'}</p>
        {signOutWarning && <SignOutWarning kind={signOutWarning} onDismiss={dismissSignOutWarning} />}
      </>
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<Consumer />))
    return captured.controls!
  }

  it('ends the session on the server before disposing the stub, and asks for the chooser next time', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, events } = signOutApi(async () => {})
    const controls = await mountWith(api)

    await act(async () => controls.logout())

    expect(events).toEqual(['signOut', 'dispose'])
    expect(localStorage.getItem('authToken')).toBeNull()
    expect(localStorage.getItem('auth.chooseAccountNext')).toBe('1')
    expect(document.body.textContent).toBe('Signed out')
    expect(document.querySelector('[role="status"]')).toBeNull()
  })

  it('signs out in the browser at once even when the server never answers, and disposes after a timeout', async () => {
    vi.useFakeTimers()
    localStorage.setItem('authToken', 'stored-token')
    const { api, events } = signOutApi(() => new Promise<void>(() => {}))
    const controls = await mountWith(api)

    await act(async () => { void controls.logout() })
    expect(document.body.textContent).toBe('Signed out')
    expect(localStorage.getItem('authToken')).toBeNull()
    expect(events).toEqual(['signOut'])

    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(events).toEqual(['signOut', 'dispose'])
    // Unanswered is not done: the sign-in page says so, naming no provider it knows nothing of.
    expect(document.body.textContent).toContain(UNCONFIRMED)
    expect(document.body.textContent).not.toContain('InferLab')
  })

  it('warns without naming InferLab when the sign-out failed for another reason', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api } = signOutApi(async () => { throw new Error('Peer closed WebSocket') })
    const controls = await mountWith(api)

    await act(async () => controls.logout())

    expect(document.body.textContent).toContain(UNCONFIRMED)
    expect(document.body.textContent).not.toContain('InferLab')
  })

  it('signs out in the browser when InferLab could not sign out, and says InferLab may still be signed in', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, events } = signOutApi(async () => { throw createSignOutError(SIGN_OUT_ERROR_CODES.providerSignOutFailed) })
    const controls = await mountWith(api)

    await act(async () => controls.logout())

    expect(events).toEqual(['signOut', 'dispose'])
    expect(localStorage.getItem('authToken')).toBeNull()
    expect(document.body.textContent).toContain('Signed out')
    const warning = document.querySelector('[role="status"]')
    expect(warning?.textContent).toContain(PROVIDER)
    expect(warning?.textContent).toContain('sign out from another InferLab app')

    // Non-blocking: it can be dismissed, and a new sign-in clears it too.
    const dismiss = [...warning!.querySelectorAll('button')].find(b => b.textContent === 'Dismiss')!
    await act(async () => dismiss.click())
    expect(document.body.textContent).not.toContain(PROVIDER)

    await act(async () => controls.login('stored-token'))
    await act(async () => controls.logout())
    expect(document.body.textContent).toContain(PROVIDER)
    await act(async () => controls.login('fresh-token'))
    expect(document.body.textContent).not.toContain(PROVIDER)
  })

  it('does not warn about a sign-out a newer sign-in has superseded', async () => {
    let refuse!: (error: Error) => void
    localStorage.setItem('authToken', 'stored-token')
    const { api } = signOutApi(() => new Promise<void>((_, reject) => { refuse = reject }))
    const controls = await mountWith(api)

    await act(async () => { void controls.logout() })
    await act(async () => controls.login('fresh-token'))
    await act(async () => refuse(createSignOutError(SIGN_OUT_ERROR_CODES.providerSignOutFailed)))

    expect(document.body.textContent).not.toContain(PROVIDER)
  })
})

/** A public API whose stub answers `whoami` by throwing `error`, counting disposals and sign-outs. */
function refusingApi(error: unknown) {
  const events: string[] = []
  const authenticated = {
    onRpcBroken: () => {},
    whoami: async () => { throw error },
    signOut: async () => { events.push('signOut') },
    [Symbol.dispose]: () => { events.push('dispose') },
  }
  const api = {
    authenticate: () => authenticated,
    authenticateFromCfAccess: () => authenticated,
  } as unknown as RpcStub<PublicApi>
  return { api, events }
}

describe('useAuth with a session ended elsewhere (FAC-300)', () => {
  const roots: Root[] = []

  afterEach(() => {
    act(() => roots.forEach(root => root.unmount()))
    roots.length = 0
    document.body.replaceChildren()
    localStorage.clear()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  async function mountWith(api: RpcStub<PublicApi>, hook: typeof useAuth = useAuth) {
    function Consumer() {
      const { isAuthenticated } = hook(api)
      return <p>{isAuthenticated ? 'Signed in' : 'Signed out'}</p>
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<Consumer />))
  }

  it('shows sign-in and forgets the stored token when the server says the session has ended', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, events } = refusingApi(createAuthError(AUTH_ERROR_CODES.invalidSessionToken))
    await mountWith(api)

    expect(document.body.textContent).toBe('Signed out')
    expect(localStorage.getItem('authToken')).toBeNull()
    // Nothing is left to end on the server, and this browser didn't sign out: no chooser next time.
    expect(events).toEqual(['dispose'])
    expect(localStorage.getItem('auth.chooseAccountNext')).toBeNull()
    expect(setReportedUserId).toHaveBeenCalledWith(undefined)
  })

  it('recognises the refusal by its message when native RPC dropped the code', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const message = AUTH_ERROR_MESSAGES[AUTH_ERROR_CODES.invalidSessionToken]
    const { api } = refusingApi(new Error(message))
    await mountWith(api)

    expect(document.body.textContent).toBe('Signed out')
    expect(localStorage.getItem('authToken')).toBeNull()
  })

  it('stays signed in on any other failure (a dropped connection is retried, not a sign-out)', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, events } = refusingApi(new Error('WebSocket closed'))
    await mountWith(api)

    expect(document.body.textContent).toBe('Signed in')
    expect(localStorage.getItem('authToken')).toBe('stored-token')
    expect(events).toEqual([])
  })

  it('never signs a Cloudflare Access session out on this path', async () => {
    vi.stubEnv('VITE_CF_ACCESS_MODE', 'true')
    vi.resetModules()
    const { useAuth: cfAccessUseAuth } = await import('./useAuth')
    const { api } = refusingApi(createAuthError(AUTH_ERROR_CODES.invalidSessionToken))
    await mountWith(api, cfAccessUseAuth)

    expect(document.body.textContent).toBe('Signed in')
  })

  it('releases this device as a sign-out does, so a shared computer stops showing the chats', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api } = refusingApi(createAuthError(AUTH_ERROR_CODES.invalidSessionToken))
    await mountWith(api)

    expect(disconnectNativeNotificationEnrollment).toHaveBeenCalledOnce()
  })

  it('keeps a newer token another tab stored while the ended one was being refused', async () => {
    localStorage.setItem('authToken', 'ended-token')
    let refuse: (error: unknown) => void = () => {}
    const refused = new Promise<never>((_, reject) => { refuse = reject })
    const authenticated = {
      onRpcBroken: () => {},
      whoami: () => refused,
      [Symbol.dispose]: () => {},
    }
    const api = {
      authenticate: () => authenticated,
      authenticateFromCfAccess: () => authenticated,
    } as unknown as RpcStub<PublicApi>
    await mountWith(api)

    localStorage.setItem('authToken', 'newer-token')
    await act(async () => refuse(createAuthError(AUTH_ERROR_CODES.invalidSessionToken)))

    expect(document.body.textContent).toBe('Signed out')
    expect(localStorage.getItem('authToken')).toBe('newer-token')
  })

  it('a reconnect with no stored token drops the stub it held, rather than a dead signed-in shell', async () => {
    // Two instances share the token (the blueprint page mounts its own): when one forgets an ended
    // session, the other's next reconnect finds no token and must not keep its disposed stub.
    localStorage.setItem('authToken', 'stored-token')
    const before = stubPublicApi(person)
    const after = stubPublicApi(person)
    function Consumer({ api }: { api: RpcStub<PublicApi> }) {
      const { isAuthenticated } = useAuth(api)
      return <p>{isAuthenticated ? 'Signed in' : 'Signed out'}</p>
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<Consumer api={before} />))
    expect(container.textContent).toBe('Signed in')

    localStorage.removeItem('authToken')
    await act(async () => root.render(<Consumer api={after} />))

    expect(container.textContent).toBe('Signed out')
  })
})
