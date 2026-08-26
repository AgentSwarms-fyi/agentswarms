// Thin, safe wrapper around sessionStorage for autosaving in-progress form
// state (e.g. a "Create X" modal that would otherwise lose everything typed
// into it if the user clicks outside and the dialog unmounts).
//
// sessionStorage — not localStorage — is the right primitive here: a draft
// is "what I was in the middle of typing this tab session," not a
// preference that should survive a browser restart days later.
//
// Every call is wrapped in try/catch because storage access can throw in
// private/incognito modes, when it's disabled by browser policy, or when the
// quota is exceeded — none of which should ever crash the form. Worst case,
// autosave silently no-ops and the form still works exactly as if this
// module didn't exist.

export function loadDraft<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveDraft<T>(key: string, value: T): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full/disabled/blocked — the field is still set in React state,
    // it just won't survive the modal closing.
  }
}

export function clearDraft(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore — there's nothing meaningful to recover from here.
  }
}
