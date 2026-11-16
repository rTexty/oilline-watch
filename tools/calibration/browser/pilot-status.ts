import type { DomainCode } from '../../../src/physics/guards'
import type { RunSnapshot } from '../../../src/runtime/vertical-protocol'

export type PacedFailure = DomainCode | 'worker-error' | 'transport-error' | 'wall-timeout'

export function validationFailure(failure: PacedFailure, stage: 'bootstrap' | 'execution', timeUs: number) {
  return { kind: 'validation-failure' as const, phase: 'error' as const, failure, stage, timeUs, closureEvidenceMissing: false }
}

interface Terminal {
  readonly phase: RunSnapshot['phase']
  readonly timeUs: number
  readonly failure: PacedFailure | null
  readonly closureEvidenceMissing: boolean
}

export function pacedPilotStatus(result: Terminal, targetUs: number, horizonUs: number) {
  if (result.failure === 'outside-model-domain' || result.failure === 'uncertain-flow-regime') return 'invalid-domain'
  if (result.failure === 'unsupported-physics') return 'unsupported'
  if (result.failure) return result.failure
  if (result.phase !== 'completed' || result.timeUs !== targetUs) return 'worker-error'
  if (result.closureEvidenceMissing) return 'incomplete-closure'
  return targetUs === horizonUs ? 'completed' : 'pilot-cutoff'
}
