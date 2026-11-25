// Shown on the sign-in page when signing out ended the session here but the server could not end
// the InferLab sign-in behind it everywhere (FAC-300): it failed, or did not answer in time. The
// session is already gone, so there is nothing left here to retry with; the person finishes from an
// app still signed in through InferLab.

import { Banner, Button } from '@cloudflare/kumo'

/** The warning's heading. */
export const SIGN_OUT_INCOMPLETE_TITLE =
  "You're signed out of InferOS, but InferLab couldn't sign you out everywhere."

/** What the person can do about it. */
export const SIGN_OUT_INCOMPLETE_DESCRIPTION =
  "InferOS can't try again now that this session has ended. To finish, sign out from another InferLab app."

export default function SignOutWarning({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Banner
      variant="alert"
      role="status"
      className="mb-6"
      title={SIGN_OUT_INCOMPLETE_TITLE}
      description={SIGN_OUT_INCOMPLETE_DESCRIPTION}
      action={<Button size="sm" variant="secondary" onClick={onDismiss}>Dismiss</Button>}
    />
  )
}
