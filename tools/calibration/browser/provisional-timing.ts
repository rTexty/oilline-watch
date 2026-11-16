export interface PacedProvisionalPublication {
  readonly jobId: string
  readonly publishedAtUs: number
  readonly submittedEpochMs: number
}

export interface PacedFinalPublication {
  readonly jobId: string
  readonly submittedEpochMs: number
  readonly finalDisposition: 'committed' | 'discarded'
}

export const CROSS_CONTEXT_CLOCK_SKEW_MS = 1

function validReceipt(admittedEpochMs: number, submittedEpochMs: number, receivedEpochMs: number): boolean {
  return Number.isFinite(submittedEpochMs) && Number.isFinite(receivedEpochMs)
    && submittedEpochMs >= admittedEpochMs && receivedEpochMs >= admittedEpochMs
    && submittedEpochMs - receivedEpochMs <= CROSS_CONTEXT_CLOCK_SKEW_MS
}

export function createPacedProvisionalTimings() {
  const admissions = new Map<string, number>()
  const provisionalTimings = new Map<string, {
    readonly publishedAtUs: number; readonly submittedMs: number; readonly provisionalMs: number
  }>()
  const finalTimings = new Map<string, {
    readonly finalPageMs: number; readonly finalDisposition: PacedFinalPublication['finalDisposition']
  }>()
  return {
    admit(jobId: string, admittedEpochMs: number): void {
      if (Number.isFinite(admittedEpochMs) && !admissions.has(jobId)) admissions.set(jobId, admittedEpochMs)
    },
    observe(publication: PacedProvisionalPublication, receivedEpochMs: number): void {
      const { jobId, publishedAtUs, submittedEpochMs } = publication
      const admittedEpochMs = admissions.get(jobId)
      if (admittedEpochMs === undefined || provisionalTimings.has(jobId) || finalTimings.has(jobId)
        || !validReceipt(admittedEpochMs, submittedEpochMs, receivedEpochMs)) return
      provisionalTimings.set(jobId, {
        publishedAtUs,
        submittedMs: submittedEpochMs - admittedEpochMs,
        provisionalMs: receivedEpochMs - admittedEpochMs,
      })
    },
    observeFinal(publication: PacedFinalPublication, receivedEpochMs: number): void {
      const { jobId, submittedEpochMs, finalDisposition } = publication
      const admittedEpochMs = admissions.get(jobId)
      if (admittedEpochMs === undefined || finalTimings.has(jobId)
        || !validReceipt(admittedEpochMs, submittedEpochMs, receivedEpochMs)) return
      const finalPageMs = receivedEpochMs - admittedEpochMs
      const provisional = provisionalTimings.get(jobId)
      if (provisional && (finalPageMs < provisional.provisionalMs
        || submittedEpochMs - admittedEpochMs < provisional.submittedMs)) return
      finalTimings.set(jobId, { finalPageMs, finalDisposition })
    },
    entries() {
      return Array.from(admissions.keys(), (jobId) => ({
        jobId,
        ...(provisionalTimings.get(jobId) ?? { publishedAtUs: null, submittedMs: null, provisionalMs: null }),
        ...(finalTimings.get(jobId) ?? { finalPageMs: null, finalDisposition: null }),
      }))
    },
  }
}
