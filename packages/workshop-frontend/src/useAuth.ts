import { useState, useEffect, useRef } from 'react'
import { RpcStub } from 'capnweb'
import {
  PublicApi,
  AuthenticatedApi,
  AUTH_ERROR_CODES,
  AUTH_ERROR_MESSAGES,
  SIGN_OUT_ERROR_CODES,
  getAuthErrorCode,
  getSignOutErrorCode,
} from '@gadgets/workshop-shared/api'
import { setReportedUserId } from './errorReporting'
import { nativeApp } from './features/native-app/nativeApp'
import { NativeConnectSession } from './features/native-app/connectSession'
import { browserPushSupport, disableBrowserPush } from './features/notifications/browserPush'
import { forgetModelSelection } from './modelSelection'
import { disconnectNativeNotificationEnrollment } from './features/notifications/nativeNotificationEnrollment'
import { setChooseAccountNext } from './features/auth/chooseAccount'
import type { SignOutWarningKind } from './features/auth/SignOutWarning'

const CF_ACCESS_MODE = import.meta.env.VITE_CF_ACCESS_MODE === 'true'

// How long logout waits for the server to end the session before disposing the stub anyway, and
// reporting that the sign-out was not confirmed (FAC-300). Past the server's own bound on the
// provider's sign-out, so a provider failure is reported as one.
const SIGN_OUT_TIMEOUT_MS = 8000

/**
 * True when the server refused a token because its session has ended: signed out here or in
 * another app (a sign-out in any InferLab app ends this one too, FAC-300), expired, or backed by a
 * provider sign-in that has ended. Matched on the code, or on the message when native RPC dropped it.
 */
function isEndedSession(error: unknown): boolean {
  if (getAuthErrorCode(error) === AUTH_ERROR_CODES.invalidSessionToken) return true
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(AUTH_ERROR_MESSAGES[AUTH_ERROR_CODES.invalidSessionToken])
}

interface AuthState {
  token: string | null
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  isLoading: boolean
  error: string | null
}

export { CF_ACCESS_MODE }

export function useAuth(publicApi: RpcStub<PublicApi>) {
  const [nativeConnectSession] = useState(() => new NativeConnectSession())
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    authenticatedApi: null,
    isLoading: true,
    error: null
  })

  // Track current authenticated API stub for cleanup on unmount.
  // State closures go stale in cleanup functions, so we use a ref.
  const authenticatedApiRef = useRef<RpcStub<AuthenticatedApi> | null>(null)
  authenticatedApiRef.current = authState.authenticatedApi
  // Counts sign-ins and sign-outs, so a sign-out's late answer can tell it has been superseded.
  const authGeneration = useRef(0)
  // Why the last sign-out may not have ended everything on the server (see logout), or null.
  // Cleared by the next sign-in or by dismissing it.
  const [signOutWarning, setSignOutWarning] = useState<SignOutWarningKind | null>(null)

  /**
   * Names the signed-in user on error reports, for as long as this stub is the current one.
   *
   * Keyed on the stub rather than called from each authenticate path, so it covers however the
   * session was established — stored token, inline login, or CF Access. This is why the claim lives
   * in the hook and not in `AuthProvider`: the public blueprint page renders outside that provider
   * and logs in inline, so reports from the rest of its session would otherwise name nobody.
   *
   * `whoami` is pipelined rather than awaited, so its answer can outlive the session that asked.
   * The cleanup drops it when the stub is replaced or cleared, which is what stops a logout or a
   * newer login from being overwritten by the previous user. Disposal would not be enough on its
   * own: capnweb does not guarantee that disposing a stub rejects calls already in flight.
   *
   * Nothing is cleared here. Cleanup also runs on unmount, and two instances of this hook can be
   * mounted at once — the blueprint page runs its own inside the root's — so an inner one going
   * away must not blank an identity the outer still holds. `logout` is the only thing that clears.
   */
  useEffect(() => {
    const authenticatedApi = authState.authenticatedApi
    if (!authenticatedApi) return
    let cancelled = false
    const identity = authenticatedApi.whoami()
    const untrack = nativeConnectSession.track(authenticatedApi, identity)
    identity.then((info) => {
      // Only a real user account names a person: for a gadget author `id` is its owner's id.
      if (!cancelled && info.type === 'user') setReportedUserId(info.id)
    }).catch((error: unknown) => {
      // The stored token's session has ended (FAC-300): leave the signed-in view for the sign-in
      // page rather than a shell whose every call is refused. Only this stub's own answer counts,
      // and a Cloudflare Access session has no token to forget.
      if (!cancelled && !CF_ACCESS_MODE && isEndedSession(error)) forgetEndedSession(authenticatedApi)
    })
    return () => { cancelled = true; untrack() }
  }, [authState.authenticatedApi, nativeConnectSession])

  /**
   * Forgets a session the server has already ended: no `signOut` call (there is nothing left to
   * end), no chooser request (this browser didn't sign out; another app or an expiry did), and no
   * warning. The next sign-in starts from the sign-in page.
   */
  const forgetEndedSession = (ended: RpcStub<AuthenticatedApi>) => {
    if (authenticatedApiRef.current !== ended) return
    authGeneration.current++
    setReportedUserId(undefined)
    localStorage.removeItem('authToken')
    setAuthState(prev => {
      if (prev.authenticatedApi !== ended) return prev
      ended[Symbol.dispose]()
      return { token: null, authenticatedApi: null, isLoading: false, error: null }
    })
  }

  useEffect(() => {
    if (CF_ACCESS_MODE) {
      authenticateWithCfAccess()
    } else {
      const storedToken = localStorage.getItem('authToken')
      if (storedToken) {
        authenticateWithToken(storedToken)
      } else {
        setAuthState(prev => ({ ...prev, isLoading: false }))
      }
    }
    return () => {
      // The authenticateWithXxx functions also dispose the old stub via their setAuthState
      // updater, so this may double-dispose on reconnect. That's fine — dispose is idempotent.
      authenticatedApiRef.current?.[Symbol.dispose]()
    }
  }, [publicApi])

  const authenticateWithCfAccess = () => {
    authGeneration.current++
    setSignOutWarning(null)
    setAuthState(prev => {
      if (prev.authenticatedApi) {
        prev.authenticatedApi[Symbol.dispose]()
      }
      return { ...prev, authenticatedApi: null, isLoading: true, error: null }
    })

    // Use promise pipelining - no need to await. The CF Access JWT is already attached
    // to the request by the browser (injected by the Access service worker/cookie), so
    // the server validates it and returns an authenticated stub immediately.
    const authenticatedApi = publicApi.authenticateFromCfAccess()
    setAuthState({
      token: null,
      authenticatedApi,
      isLoading: false,
      error: null
    })
  }

  const authenticateWithToken = (token: string) => {
    authGeneration.current++
    setSignOutWarning(null)
    setAuthState(prev => {
      // Dispose the previous authenticated API stub if it exists
      if (prev.authenticatedApi) {
        prev.authenticatedApi[Symbol.dispose]()
      }
      return {
        ...prev,
        authenticatedApi: null, // Clear the disposed stub
        isLoading: true,
        error: null
      }
    })

    // Use promise pipelining - we can use the returned promise as a stub immediately
    // without awaiting. Authentication errors will be handled when the stub is actually used.
    const authenticatedApi = publicApi.authenticate(token)
    setAuthState({
      token,
      authenticatedApi,
      isLoading: false,
      error: null
    })
  }

  const login = (token: string) => {
    authenticateWithToken(token)
  }

  /**
   * Signs out. The browser forgets the session at once; the returned promise settles once the
   * server has answered, or after SIGN_OUT_TIMEOUT_MS. The server ends the session too (FAC-300):
   * its token is refused from then on, and a provider sign-in backing it is ended everywhere. When
   * that failed or did not answer in time, `signOutWarning` says how, so the sign-in page can say
   * so: `provider` when the server reports the provider's sign-out failed, `unconfirmed` otherwise.
   * The next sign-in asks for the provider's account chooser.
   */
  const logout = (): Promise<void> => {
    const generation = ++authGeneration.current
    try {
      disconnectNativeNotificationEnrollment()
      nativeApp()?.sessionEnded?.()
    } catch (error) {
      console.error('Failed to disconnect native notifications:', error)
    }
    setReportedUserId(undefined)
    // On a shared computer, signing out is how the user stops this browser showing their chats.
    const releasePush = browserPushSupport() === 'supported'
      ? disableBrowserPush().catch(error =>
          console.error('Failed to stop browser notifications:', error))
      : Promise.resolve()

    // A Cloudflare Access session has no token to end here: Access's own logout ends it.
    const signingOut = CF_ACCESS_MODE ? null : authenticatedApiRef.current
    let finished = Promise.resolve()
    if (signingOut) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const ended = Promise.resolve().then(() => signingOut.signOut()).then(
        () => null,
        (error: unknown): SignOutWarningKind =>
          getSignOutErrorCode(error) === SIGN_OUT_ERROR_CODES.providerSignOutFailed ? 'provider' : 'unconfirmed')
      const timeout = new Promise<SignOutWarningKind>(resolve => {
        timer = setTimeout(() => resolve('unconfirmed'), SIGN_OUT_TIMEOUT_MS)
      })
      finished = Promise.race([ended, timeout]).then(warning => {
        clearTimeout(timer)
        signingOut[Symbol.dispose]()
        // A sign-in since then is a new session, which this warning is not about.
        if (warning && generation === authGeneration.current) setSignOutWarning(warning)
      })
    }
    setSignOutWarning(null)
    setChooseAccountNext()

    setAuthState(prev => {
      if (prev.authenticatedApi !== signingOut) prev.authenticatedApi?.[Symbol.dispose]()
      return {
        token: null,
        authenticatedApi: null,
        isLoading: false,
        error: null
      }
    })
    localStorage.removeItem('authToken')
    forgetModelSelection()

    if (CF_ACCESS_MODE) {
      void releasePush.then(() => window.location.assign('/cdn-cgi/access/logout'))
    }
    return finished
  }

  const dismissSignOutWarning = () => setSignOutWarning(null)

  return {
    ...authState,
    login,
    logout,
    signOutWarning,
    dismissSignOutWarning,
    isAuthenticated: !!authState.authenticatedApi
  }
}
