import { useRef } from 'react';
import type { RunSnapshot } from '../app/worker-client';
import { CHALLENGE_WARMUP_US } from '../contracts/model';
import { formatTime } from './Status';
import { PRESSURE_STATIONS } from './pipe-3d';

const pressureFormat = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 2, minimumFractionDigits: 2, signDisplay: 'exceptZero',
});

export function formatPressureDelta(residualPa: number) {
  return `${pressureFormat.format(residualPa / 1_000)} кПа`;
}

const STEPS = ['Запуск', 'Утечка', 'Невязка', 'Раскрытие'];

function DemoSteps({ current }: { readonly current: number }) {
  return (
    <ol className="pipe-demo-steps" aria-label="Этапы показа">
      {STEPS.map((label, index) => (
        <li key={label} aria-current={index === current ? 'step' : undefined} data-done={index < current}>
          <span aria-hidden="true">{index + 1}</span>{label}
        </li>
      ))}
    </ol>
  );
}

export function PipeDemoGuide({ run, starting, guided, leakSubmitted, responseTimeUs, onStart, onShowResidual }: {
  readonly run: RunSnapshot | null;
  readonly starting: boolean;
  readonly guided: boolean;
  readonly leakSubmitted: boolean;
  readonly responseTimeUs: number | null;
  readonly onStart: () => void;
  readonly onShowResidual: () => void;
}) {
  const stageLabel = useRef<HTMLParagraphElement>(null);
  if (run?.replaying) return null;

  if (run?.truth) {
    const position = run.truth.positionM;
    const distanceFrom = (station: (typeof PRESSURE_STATIONS)[number]) => Math.abs(station.locationM - position);
    const closest = Math.min(...PRESSURE_STATIONS.map(distanceFrom));
    const sensors = PRESSURE_STATIONS.filter(station => distanceFrom(station) === closest);
    return (
      <section className="pipe-demo pipe-demo-result" aria-label="Испытание на модели">
        <DemoSteps current={3} />
        <div className="pipe-demo-copy">
          <p>Место утечки</p>
          <span className="pipe-demo-distance">До {sensors.map(({ label }) => label).join(' и ')} по трубе · {closest} м</span>
        </div>
        <strong>{position} м</strong>
      </section>
    );
  }

  if (!guided && (run || starting)) return null;
  if (run?.phase === 'completed' || run?.phase === 'invalid' || run?.phase === 'error') return null;

  const warming = run?.phase === 'warming-up';
  const armed = run?.armedAtUs != null;
  const canInject = run?.phase === 'running' && run.armedAtUs !== null && !leakSubmitted;
  const applied = run?.leakStatus === 'applied';

  return (
    <section className="pipe-demo" aria-label="Испытание на модели">
      <DemoSteps current={run?.phase === 'finalizing' ? 3 : applied ? 2 : armed || leakSubmitted ? 1 : 0} />
      <div className="pipe-demo-copy">
        <p ref={stageLabel} tabIndex={-1} aria-live="polite">{run?.phase === 'finalizing' ? 'Подготовка результата'
          : applied ? (responseTimeUs !== null ? 'Реакция датчиков' : 'Утечка введена · ждём отсчёты')
          : leakSubmitted ? 'Команда отправлена'
          : canInject ? 'Стенд готов к утечке'
          : warming ? 'Штатный разогрев'
          : run?.phase === 'paused' ? 'Расчёт на паузе'
          : starting ? 'Подключение к расчёту'
          : 'Выберите точку на трубе'}</p>
        {warming ? (
          <progress aria-label="Разогрев модели" max={CHALLENGE_WARMUP_US} value={run.timeUs} />
        ) : null}
        {responseTimeUs !== null ? <span className="pipe-demo-time">По модели · {formatTime(responseTimeUs)}</span> : null}
      </div>
      {!run && !starting ? (
        <button className="button button-primary pipe-demo-action" type="button" onClick={() => {
          stageLabel.current?.focus({ preventScroll: true });
          onStart();
        }}>
          Начать показ <span aria-hidden="true">· 4×</span>
        </button>
      ) : canInject ? (
        <a className="button button-secondary pipe-demo-action" href="#leak-title">К форме утечки</a>
      ) : applied && run.phase !== 'finalizing' ? (
        <a className="button button-secondary pipe-demo-action" href="#trend-title" onClick={onShowResidual}>Смотреть невязку</a>
      ) : null}
      {run && responseTimeUs !== null && (
        <dl className="pipe-demo-readings" aria-label="Отклонение давления после утечки">
          {PRESSURE_STATIONS.map(({ label }, index) => {
            const pressure = run.residualPa[index];
            return <div key={label}><dt>{label}</dt><dd>{pressure == null ? '—' : formatPressureDelta(pressure)}</dd></div>;
          })}
        </dl>
      )}
    </section>
  );
}
