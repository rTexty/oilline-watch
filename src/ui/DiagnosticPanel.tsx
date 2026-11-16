import type { Ref } from 'react';
import type { RunSnapshot } from '../app/worker-client';
import type { DiagnosticResult, ProvisionalDiagnostic } from '../contracts/inference';
import { formatTime } from './Status';
import { forecastLink } from './forecast-links';

const SCORE_LABELS = {
  M0: 'Штатный режим (M0)',
  ML: 'Внутренний отбор (ML)',
  MB: 'Граничное возмущение (MB)',
  MS: 'Смещение датчика (MS)',
} as const;

const scoreFormat = new Intl.NumberFormat('ru-RU', { maximumSignificantDigits: 5 });

function statusTitle(run: RunSnapshot | null, result: DiagnosticResult | null | undefined): string {
  const diagnostic = run?.diagnostic;
  if (run?.phase === 'invalid' || run?.phase === 'error') return 'Расчёт остановлен';
  if (diagnostic?.availability === 'missing' || result?.availability === 'missing') return 'Данные недоступны';
  if (diagnostic?.availability === 'insufficient-history' || result?.availability === 'insufficient-history') return 'Недостаточно истории';
  if (result?.availability === 'out-of-domain') return 'Гипотезы вне области модели';
  if (diagnostic?.qualified && result?.hypotheses.some(({ model, support }) => model === 'ML' && support === 'compatible')) {
    return 'Поддержан внутренний отбор, совместимый с утечкой';
  }
  if (diagnostic?.alarmOpen) return 'Аномалия давления';
  if (!diagnostic?.qualified) return 'Калибровка отсутствует';
  if (result && !result.searchComplete) return 'Поиск не завершён';
  if (result?.fitQuality === 'poor') return 'Модель внутреннего отбора не объясняет наблюдения';
  if (result?.fitQuality === 'good') return 'Причина неоднозначна';
  return 'Наблюдение';
}

function ProvisionalEvidence({ evidence, historical, replaying }: {
  readonly evidence: ProvisionalDiagnostic;
  readonly historical: boolean;
  readonly replaying: boolean;
}) {
  const status = historical ? 'До изменения управления · причина не установлена'
    : replaying ? 'Воспроизведение · на этом этапе причина не установлена'
      : 'Поиск продолжается · причина не установлена';
  return (
    <>
      <h3 className="diagnosis-state">Предварительные данные</h3>
      <p role="status">{status}</p>
      <p>Точные оценки проверенных вариантов. Меньше означает лучшее соответствие данным.</p>
      <dl className="diagnosis-values">
        <div><dt>Данные по</dt><dd>{formatTime(evidence.observedThroughUs)}</dd></div>
        {(Object.keys(SCORE_LABELS) as (keyof typeof SCORE_LABELS)[]).map((model) => {
          const score = evidence.scores[model];
          return <div key={model}><dt>{SCORE_LABELS[model]}</dt><dd>{score == null ? 'Нет оценки' : scoreFormat.format(score)}</dd></div>;
        })}
      </dl>
    </>
  );
}

export function DiagnosticPanel({ run, revealHeading, onShowPipe }: {
  readonly run: RunSnapshot | null;
  readonly revealHeading?: Ref<HTMLHeadingElement>;
  readonly onShowPipe?: () => void;
}) {
  const diagnostic = run?.diagnostic;
  const pending = diagnostic?.provisional;
  const provisional = pending && (run?.phase === 'running' || run?.phase === 'paused')
    && pending.jobId !== diagnostic?.result?.jobId ? pending : null;
  const result = provisional ? null : diagnostic?.result;
  const compatible = result?.compatibleRegions.filter((region) => region.status === 'compatible') ?? [];
  const unresolved = result?.compatibleRegions.filter((region) => region.status === 'unresolved') ?? [];

  return (
    <section className="panel diagnosis-panel" aria-labelledby="diagnosis-title" id="diagnosis">
      <header className="panel-heading">
        <div>
          <h2 id="diagnosis-title">Диагностика</h2>
          <p>Оценка по публичной телеметрии</p>
        </div>
      </header>
      <div className="diagnosis-body">
        <div className="diagnosis-state" role="status">
          <span className="state-indicator" aria-hidden="true" />
          <span>{statusTitle(run, diagnostic?.historical ? null : result)}</span>
        </div>
        {provisional ? <ProvisionalEvidence evidence={provisional} historical={diagnostic?.provisionalHistorical === true} replaying={run?.replaying === true} />
          : <p>{diagnostic?.explanation ?? 'Количественная тревога и интервалы координат недоступны до квалификации.'}</p>}
        <dl className="diagnosis-values">
          <div><dt>Модельное время последней тревоги</dt><dd>{diagnostic?.alarmAtUs == null ? '—' : formatTime(diagnostic.alarmAtUs)}</dd></div>
          {provisional ? null : <div><dt>Проверенные совместимые области</dt><dd>{compatible.length ? compatible.map((region) => `${region.startM}–${region.endM} м`).join(', ') : '—'}</dd></div>}
          {unresolved.length ? <div><dt>Неопределённые области</dt><dd>{unresolved.map((region) => `${region.startM}–${region.endM} м`).join(', ')}</dd></div> : null}
          {result ? <div><dt>Данные по</dt><dd>{formatTime(result.observedThroughUs)}{diagnostic?.historical ? ' · до изменения управления' : ''}</dd></div> : null}
        </dl>
        {run?.truth ? (
          <div className="reveal">
            <h3 ref={revealHeading} tabIndex={-1}>Раскрытое событие</h3>
            <dl className="diagnosis-values">
              <div><dt>Координата</dt><dd>{run.truth.positionM} м</dd></div>
              <div><dt>CdA</dt><dd>{(run.truth.cdAreaM2 / 1e-5).toLocaleString('ru-RU')} ×10⁻⁵ м²</dd></div>
              <div><dt>Время открытия</dt><dd>{run.truth.openingUs / 1_000_000} с</dd></div>
              <div><dt>Модельное время события</dt><dd>{formatTime(run.truth.timeUs)}</dd></div>
            </dl>
            <a className="control-link" href={forecastLink('degradation.html')}>Прогноз толщины <span aria-hidden="true">↗</span></a>
            <a className="control-link reveal-pipe-link" href="#pipe-title" onClick={onShowPipe}>Показать точку на трубе <span aria-hidden="true">↑</span></a>
          </div>
        ) : run?.replay ? (
          <div className="reveal">
            <h3 ref={revealHeading} tabIndex={-1}>Итог сценария</h3>
            <p>В завершённом сценарии скрытой утечки не было.</p>
            <a className="control-link" href="#operation-title">К управлению сценарием <span aria-hidden="true">↑</span></a>
          </div>
        ) : null}
      </div>
    </section>
  );
}
