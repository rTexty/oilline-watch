import { describe, expect, it } from 'vitest'
import { assessWithdrawalFit, onsetIsLeftCensored } from '../../src/detection/hypothesis-decision'

const thresholds = { improvement: 10, separation: 3, absoluteFit: 2 }
const evidence = {
  scores: { M0: 38, ML: 18, MB: 21, MS: 26 },
  observations: 10,
  completed: true,
  available: true,
  positiveWithdrawal: true,
  profileQualified: true,
}

describe('calibrated withdrawal fit', () => {
  it('applies improvement, competing-model separation, and per-observation absolute fit', () => {
    expect(assessWithdrawalFit(evidence, thresholds)).toEqual({
      fitQuality: 'good', supportsWithdrawal: true,
      statistics: { improvement: 20, separation: 3, absoluteFit: 1.8 },
    })
    expect(assessWithdrawalFit(evidence, { ...thresholds, absoluteFit: 1.7 })).toMatchObject({
      fitQuality: 'poor', supportsWithdrawal: false,
    })
    expect(assessWithdrawalFit(evidence, { ...thresholds, improvement: 21 }).supportsWithdrawal).toBe(false)
    expect(assessWithdrawalFit(evidence, { ...thresholds, separation: 4 }).supportsWithdrawal).toBe(false)
  })

  it('abstains when fit evidence is incomplete, unavailable, or lacks qualified coverage', () => {
    expect(assessWithdrawalFit({ ...evidence, completed: false }, thresholds)).toMatchObject({
      fitQuality: 'unqualified', supportsWithdrawal: false,
    })
    expect(assessWithdrawalFit({ ...evidence, available: false }, thresholds).supportsWithdrawal).toBe(false)
    expect(assessWithdrawalFit({ ...evidence, profileQualified: false }, thresholds)).toMatchObject({
      fitQuality: 'good', supportsWithdrawal: false,
    })
    expect(assessWithdrawalFit({ ...evidence, positiveWithdrawal: false }, thresholds).supportsWithdrawal).toBe(false)
  })

  it('leaves ties and invalid competitors unresolved', () => {
    expect(assessWithdrawalFit({ ...evidence, scores: { ...evidence.scores, MS: 18 } }, {
      ...thresholds, separation: 0,
    }).supportsWithdrawal).toBe(false)
    expect(assessWithdrawalFit({ ...evidence, scores: { ...evidence.scores, MB: null } }, thresholds).statistics).toBeNull()
    expect(assessWithdrawalFit({ ...evidence, scores: { ...evidence.scores, MS: Number.NaN } }, thresholds).statistics).toBeNull()
    expect(assessWithdrawalFit({ ...evidence, observations: 0 }, thresholds).statistics).toBeNull()
    expect(assessWithdrawalFit(evidence, null).fitQuality).toBe('unqualified')
  })

  it('treats a competitive guard-edge fit as left-censored even when the winner is interior', () => {
    expect(onsetIsLeftCensored(18, 20, 38, 2)).toBe(true)
    expect(onsetIsLeftCensored(18, 21, 38, 2)).toBe(false)
    expect(onsetIsLeftCensored(18, 20, 20, 2)).toBe(false)
    expect(onsetIsLeftCensored(18, null, 38, 2)).toBe(false)
  })
})
