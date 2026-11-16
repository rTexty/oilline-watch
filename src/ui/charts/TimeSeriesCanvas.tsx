import { useEffect, useId, useMemo, useRef } from 'react';
import type { TrendPoint } from '../../app/store';
import { drawChart, type ChartSeries } from './draw';

export type ChartView = 'pressure' | 'residual' | 'temperature';
type TrendValues = Exclude<keyof TrendPoint, 'timeUs' | 'residualTimeUs'>;

const VIEWS = [
  { id: 'pressure', label: 'Давление' },
  { id: 'residual', label: 'Невязка' },
  { id: 'temperature', label: 'Температура' },
] as const;
const COLORS = ['#346785', '#635e87', '#39746f'];

function chartSeries(view: ChartView, trend: readonly TrendPoint[]) {
  function lines(key: TrendValues, labels: readonly string[], dashed = false): ChartSeries[] {
    return labels.map((label, index) => ({
      label,
      color: COLORS[index] ?? '#617180',
      dashed,
      points: trend.flatMap((point, pointIndex) => {
        const residual = key === 'residualKpa';
        const timeUs = residual ? point.residualTimeUs : point.timeUs;
        if (timeUs === null || (residual && trend[pointIndex - 1]?.residualTimeUs === timeUs)) return [];
        return [{ timeS: timeUs / 1_000_000, value: point[key][index] ?? null }];
      }),
    }));
  }

  if (view === 'temperature') {
    return {
      series: lines('temperaturesC', ['Нефть · начало', 'Нефть · выход', 'Стенка · выход']),
      unit: '°C',
      defaultRange: [30, 60] as const,
      minSpan: 2,
    };
  }

  if (view === 'residual') {
    return {
      series: lines('residualKpa', ['P1', 'P2', 'P3']),
      unit: 'кПа',
      defaultRange: [-5, 5] as const,
      minSpan: 4,
      referenceZero: true,
    };
  }

  return {
    series: [
      ...lines('pressureBar', ['P1', 'P2', 'P3']),
      ...lines('predictionBar', ['P1', 'P2', 'P3'], true),
    ],
    unit: 'бар абс.',
    defaultRange: [11, 12.5] as const,
    minSpan: 0.4,
  };
}

export function TimeSeriesCanvas({ trend, thermalOnly, showResidual, view, onViewChange, revealLink }: {
  readonly trend: readonly TrendPoint[];
  readonly thermalOnly: boolean;
  readonly showResidual: boolean;
  readonly view: ChartView;
  readonly onViewChange: (view: ChartView) => void;
  readonly revealLink?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captionId = useId();
  const chart = useMemo(() => chartSeries(view, trend), [view, trend]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;

    function requestDraw() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (canvas) drawChart(canvas, { ...chart, endS: (trend.at(-1)?.timeUs ?? 0) / 1_000_000 });
      });
    }

    const observer = new ResizeObserver(requestDraw);
    observer.observe(canvas);
    requestDraw();

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [chart, trend]);

  const hasPoints = chart.series.some((line) => line.points.some((point) => point.value !== null));

  return (
    <section className="panel trends-panel" aria-labelledby="trend-title" id="telemetry">
      <header className="panel-heading trend-heading">
        <div>
          <h2 id="trend-title" tabIndex={-1}>Телеметрия</h2>
          <p>Последние 40 секунд модельного времени</p>
        </div>
        {thermalOnly ? null : <div className="segmented" role="group" aria-label="Величина на графике">
          {VIEWS.filter((item) => showResidual || item.id !== 'residual').map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={view === item.id}
              onClick={() => { onViewChange(item.id); }}
            >
              {item.label}
            </button>
          ))}
        </div>}
      </header>
      <figure className="chart-figure">
        <div className="chart-area">
          <canvas ref={canvasRef} role="img" aria-labelledby={captionId} />
          {hasPoints ? null : <div className="chart-empty">Ожидание отсчётов</div>}
        </div>
        <figcaption id={captionId} className="chart-caption">
          <span className="sr-only">
            {VIEWS.find((item) => item.id === view)?.label} по модельному времени, {chart.unit}.
            {view === 'residual' ? ' Ноль означает совпадение со штатной моделью.' : ''}
            {view === 'temperature' ? 'Текущие значения приведены в панели температуры.' : 'Текущие значения приведены в таблице датчиков.'}
          </span>
          {chart.series.filter((line) => !line.dashed).map((line) => (
            <span key={line.label} className="legend-item">
              <span className="legend-line" style={{ backgroundColor: line.color }} />
              {line.label}
            </span>
          ))}
          {view === 'pressure' ? (
            <span className="legend-item"><span className="legend-line dashed" />Штатная модель</span>
          ) : null}
        </figcaption>
      </figure>
      {view === 'residual' && revealLink ? <a className="control-link chart-next" href="#finish-title">К раскрытию точки <span aria-hidden="true">→</span></a> : null}
    </section>
  );
}
