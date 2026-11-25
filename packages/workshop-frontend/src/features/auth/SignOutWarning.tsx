// Shown on the sign-in page when signing out ended the session in this browser but the server did
// not confirm it all (FAC-300). `provider`: the server ended the session but InferLab could not end
// the sign-in behind it everywhere (`SIGN_OUT_ERROR_CODES.providerSignOutFailed`); the session is
// gone, so there is nothing left here to retry with, and the person finishes from an app still
// signed in through InferLab. `unconfirmed`: the server failed otherwise, or did not answer in time,
// so nothing is known about any provider, and none is named.

import { Banner, Button } from '@cloudflare/kumo'

/** Why the last sign-out may not have ended everything (useAuth's `signOutWarning`). */
export type SignOutWarningKind = 'provider' | 'unconfirmed'

/** The warning's heading and what the person can do, by kind. */
export const SIGN_OUT_WARNINGS: Record<SignOutWarningKind, { title: string; description: string }> = {
  provider: {
    title: "You're signed out here, but InferLab couldn't sign you out everywhere.",
    description: "This app can't try again now that its session has ended. To finish, sign out from another InferLab app.",
  },
  unconfirmed: {
    title: "You're signed out here, but the server didn't confirm the sign-out.",
    description: "Your session may stay open on the server until it expires. If you signed in through another app, sign out there too.",
  },
}

export default function SignOutWarning({ kind, onDismiss }: { kind: SignOutWarningKind; onDismiss: () => void }) {
  const { title, description } = SIGN_OUT_WARNINGS[kind]
  return (
    <Banner
      variant="alert"
      role="status"
      className="mb-6"
      title={title}
      description={description}
      action={<Button size="sm" variant="secondary" onClick={onDismiss}>Dismiss</Button>}
    />
  )
}
