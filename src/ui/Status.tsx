import type { RunSnapshot } from '../app/worker-client';

const PHASE_LABELS: Record<RunSnapshot['phase'], string> = {
  'warming-up': 'Штатный разогрев',
  running: 'Испытание идёт',
  paused: 'На паузе',
  'replay-wait': 'Проверяются записанные испытания',
  finalizing: 'Сохраняется журнал диагностики',
  completed: 'Испытание завершено',
  invalid: 'Модель вне области',
  error: 'Ошибка расчёта',
};

export function formatTime(timeUs: number) {
  const seconds = timeUs / 1_000_000;
  const minutes = Math.floor(seconds / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  const tenths = Math.floor(seconds * 10) % 10;
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${tenths}`;
}

export function Status({ run, startup, challenge, runningLabel }: {
  readonly run: RunSnapshot | null;
  readonly startup: 'live' | 'replay' | null;
  readonly challenge: boolean;
  readonly runningLabel: string;
}) {
  const phase = run?.phase ?? (startup ? 'starting' : 'idle');
  const label = run
    ? run.phase === 'running' ? runningLabel : PHASE_LABELS[run.phase]
    : startup === 'live' ? 'Запуск расчёта' : startup === 'replay' ? 'Загрузка повтора' : 'Нет запущенного сценария';
  const challengeUs = run?.armedAtUs == null ? 0 : Math.max(0, run.timeUs - run.armedAtUs);

  return (
    <section className="run-status" aria-label="Состояние сценария">
      <span className={`status-chip status-${phase}`} role="status">
        <span className="status-dot" aria-hidden="true" />
        {label}
      </span>
      <dl className="clock-strip">
        <div>
          <dt>Модельное время</dt>
          <dd>{formatTime(run?.timeUs ?? 0)}</dd>
        </div>
        {challenge ? <div>
          <dt>Время испытания</dt>
          <dd>{formatTime(challengeUs)}</dd>
        </div> : null}
      </dl>
    </section>
  );
}
