import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RunSnapshot } from '../../src/app/worker-client';
import type { DiagnosticResult, ProvisionalDiagnostic } from '../../src/contracts/inference';
import { DiagnosticPanel } from '../../src/ui/DiagnosticPanel';

const versions = {
  modelVersion: '1', profileId: 'synthetic-oil-turbulent-v1', bankVersion: '1', calibrationId: 'a'.repeat(64),
} as const;

const provisional: ProvisionalDiagnostic = {
  ...versions,
  jobId: '00000000-0000-4000-8000-000000000001',
  observedThroughUs: 31_000_000,
  controlRevision: 1,
  completedEvaluations: 2,
  scores: { M0: 12, ML: 0, MB: null, MS: null },
};

const finalResult: DiagnosticResult = {
  ...versions,
  jobId: '00000000-0000-4000-8000-000000000000',
  controlRevision: 0,
  observedThroughUs: 30_000_000,
  finishedAtUs: 31_000_000,
  completedEvaluations: 40,
  searchComplete: true,
  stopReason: 'complete',
  hypotheses: [{ model: 'ML', score: 1, completed: true, support: 'compatible' }],
  compatibleRegions: [{ status: 'compatible', startM: 400, endM: 500 }],
  fitQuality: 'good',
  availability: 'available',
  assumptions: [],
};

const run: RunSnapshot = {
  profileId: versions.profileId,
  phase: 'running',
  timeUs: 32_000_000,
  armedAtUs: 30_000_000,
  samples: [],
  prediction: [],
  residualPa: [],
  residualTimeUs: null,
  temperatures: { oilInK: 313.15, oilOutK: 313.15, wallOutK: 313.15 },
  message: null,
  appliedTimeUs: null,
  leakStatus: 'idle',
  diagnostic: null,
  truth: null,
  replay: null,
  replaying: false,
};

function render(diagnostic: Partial<NonNullable<RunSnapshot['diagnostic']>>,
  snapshot: Partial<Pick<RunSnapshot, 'phase' | 'replaying' | 'replayVerification'>> = {}) {
  return renderToStaticMarkup(<DiagnosticPanel run={{
    ...run,
    ...snapshot,
    diagnostic: { availability: 'available', explanation: 'Анализ телеметрии', qualified: true, ...diagnostic },
  }} />);
}

describe('provisional diagnostic panel', () => {
  it.each([false, true])('shows unresolved evidence independently of an alarm (%s)', (alarmOpen) => {
    const html = render({ provisional, alarmOpen });

    expect(html).toContain('Предварительные данные');
    expect(html).toContain('Поиск продолжается · причина не установлена');
    expect(html).toContain('Точные оценки проверенных вариантов');
    expect(html).toContain('(M0)</dt><dd>12</dd>');
    expect(html).toContain('(ML)</dt><dd>0</dd>');
    expect(html).toContain('(MB)</dt><dd>Нет оценки</dd>');
    expect(html).toContain('00:31.0');
    expect(html.includes('Аномалия давления')).toBe(alarmOpen);
    expect(html).not.toContain('Поддержан внутренний отбор');
  });

  it('keeps past final localization out of the live provisional evidence', () => {
    const html = render({ provisional, result: finalResult, historical: true });

    expect(html).toContain('Поиск продолжается · причина не установлена');
    expect(html).not.toContain('400–500 м');
    expect(html).not.toContain('Поддержан внутренний отбор');
  });

  it('marks historical provisional evidence as stale and omits the running status', () => {
    const html = render({ provisional, provisionalHistorical: true });

    expect(html).toContain('До изменения управления');
    expect(html).not.toContain('Поиск продолжается');
  });

  it('shows recomputed evidence during timed replay while the full replay is still pending', () => {
    const html = render({ provisional }, { replaying: true, replayVerification: 'pending' });

    expect(html).toContain('Предварительные данные');
    expect(html).toContain('Воспроизведение · на этом этапе причина не установлена');
    expect(html).toContain('(M0)</dt><dd>12</dd>');
    expect(html).not.toContain('Поиск продолжается');
  });

  it('preserves support and localization for the terminal result', () => {
    const html = render({ result: finalResult, provisional: { ...provisional, jobId: finalResult.jobId } },
      { replaying: true, replayVerification: 'pending' });

    expect(html).toContain('Поддержан внутренний отбор, совместимый с утечкой');
    expect(html).toContain('400–500 м');
    expect(html).not.toContain('Предварительные данные');
  });

  it('discards a cached provisional view when the worker fails', () => {
    const html = render({ provisional }, { phase: 'error' });

    expect(html).toContain('Расчёт остановлен');
    expect(html).not.toContain('Предварительные данные');
  });
});
