type CandidateSelection = { pipe: string; segment: number }

function storageKey(): string {
  return `pipetwin:candidate-selection:v1:${window.location.pathname}`
}

export function readCandidateSelection(): CandidateSelection | null {
  try {
    const stored = window.sessionStorage.getItem(storageKey())
    if (!stored) return null
    const selection = JSON.parse(stored) as Partial<CandidateSelection> | null
    if (typeof selection?.pipe !== 'string' || typeof selection.segment !== 'number'
      || !Number.isSafeInteger(selection.segment) || selection.segment < 0) return null
    return { pipe: selection.pipe, segment: selection.segment }
  } catch {
    return null
  }
}

export function saveCandidateSelection(pipe: string, segment: number): void {
  try {
    window.sessionStorage.setItem(storageKey(), JSON.stringify({ pipe, segment }))
  } catch {
    // Navigation still works when session storage is unavailable.
  }
}
