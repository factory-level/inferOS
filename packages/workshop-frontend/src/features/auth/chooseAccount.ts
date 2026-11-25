// Whether the next sign-in should ask the provider for its account chooser (FAC-300).
//
// Signing out sets it, so the sign-in that follows shows the chooser instead of silently signing the
// same person back in through a provider sign-in another app still holds; a successful sign-in clears
// it. Only vendors that offer a chooser (`AuthVendorInfo.chooseAccountLabel`) read it. Storage that
// throws (a private window, blocked site data) reads as unset and writes as nothing.

const KEY = 'auth.chooseAccountNext'

/** Whether the next sign-in should show the provider's account chooser. */
export function chooseAccountNext(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/** Ask for the account chooser on the next sign-in. Called when the person signs out. */
export function setChooseAccountNext(): void {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    // Best effort.
  }
}

/** Forget the request, once a sign-in has succeeded. */
export function clearChooseAccountNext(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Best effort.
  }
}
