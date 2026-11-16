import type { RunSnapshot } from '../app/worker-client';

const format = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const temperature = (value: number | undefined) => value === undefined ? '—' : `${format.format(value - 273.15)} °C`;

export function ThermalPanel({ run }: { readonly run: RunSnapshot | null }) {
  return (
    <section className="panel thermal-panel" aria-labelledby="thermal-title">
      <header className="panel-heading">
        <div>
          <h2 id="thermal-title">Температура</h2>
          <p>Нефть и стенка трубы</p>
        </div>
      </header>
      <dl className="thermal-values">
        <div><dt>Нефть в начале участка</dt><dd>{temperature(run?.temperatures.oilInK)}</dd></div>
        <div><dt>Нефть на выходе</dt><dd>{temperature(run?.temperatures.oilOutK)}</dd></div>
        <div><dt>Стенка на выходе</dt><dd>{temperature(run?.temperatures.wallOutK)}</dd></div>
      </dl>
    </section>
  );
}
