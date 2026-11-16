import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { downloadReplay } from '../app/export';
import { parseReplay } from '../app/replay';
import { createRunStore, SENSOR_IDS } from '../app/store';
import { startRun, type RunClient, type RunSnapshot } from '../app/worker-client';
import { MAX_IMPORT_BYTES, type ProfileId } from '../contracts/model';
import { WalkDialog } from '../walk/WalkDialog';
import { PRESSURE_IDS } from '../walk/model';
import { Controls } from './Controls';
import { DiagnosticPanel } from './DiagnosticPanel';
import { PipeView } from './PipeView';
import { PipeDemoGuide } from './PipeDemoGuide';
import { formatTime, Status } from './Status';
import { ThermalPanel } from './ThermalPanel';
import { TimeSeriesCanvas, type ChartView } from './charts/TimeSeriesCanvas';
import { defenseHomeLink, forecastLink } from './forecast-links';
import { LEAK_GRID_STEP_M, snapPipePosition } from './pipe-3d';
import './styles.css';
import './pipe-stage.css';

const TURBULENT_PROFILE = 'synthetic-oil-turbulent-v1';
const MODE_COPY: Record<ProfileId, { title: string; description: string; runningLabel: string }> = {
  'synthetic-oil-turbulent-v1': {
    title: 'Испытание нефтепровода',
    description: 'Создайте скрытую утечку и проследите, как меняется давление на трёх датчиках.',
    runningLabel: 'Испытание идёт',
  },
  'synthetic-oil-laminar-v1': {
    title: 'Ламинарный опыт',
    description: 'Переходный процесс при снижении выходного расхода с учётом памяти трения.',
    runningLabel: 'Ламинарный опыт идёт',
  },
  'synthetic-oil-thermal-v1': {
    title: 'Тепловой опыт',
    description: 'Динамика температуры нефти и стенки при нагреве на входе.',
    runningLabel: 'Тепловой опыт идёт',
  },
};
const DEFAULT_POSITION_M = 500;
const NUMBER = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SENSOR_POSITION_M = [100, 500, 900, 0];
const QUALITY = {
  valid: 'Есть данные',
  missing: 'Пропуск',
  'out-of-range': 'Вне диапазона',
  stuck: 'Залипание',
  late: 'Запоздал',
} as const;

function measuredValue(value: number | null | undefined, flow: boolean) {
  if (value == null) return '—';
  return `${NUMBER.format(flow ? value * 1000 : value / 100_000)} ${flow ? 'л/с' : 'бар абс.'}`;
}

function SensorTable({ run, showResidual }: { readonly run: RunSnapshot | null; readonly showResidual: boolean }) {
  return (
    <section className="panel sensor-panel" aria-labelledby="sensor-title">
      <header className="panel-heading">
        <div>
          <h2 id="sensor-title">Датчики</h2>
          <p>Последние доступные отсчёты{run?.residualTimeUs == null ? '' : ` · невязка на ${formatTime(run.residualTimeUs)}`}</p>
        </div>
      </header>
      <div className="table-wrap">
        <table className="sensor-table">
          <thead>
            <tr><th scope="col">Канал</th><th scope="col">Координата</th><th scope="col">Измерение</th><th scope="col">Штатная модель</th><th scope="col">Качество</th>{showResidual ? <th scope="col">Невязка</th> : null}</tr>
          </thead>
          <tbody>
            {SENSOR_IDS.map((id, index) => {
              const sample = run?.samples.findLast((measurement) => measurement.sensorId === id);
              const flow = id === 'Qin';
              const residual = flow ? null : run?.residualPa[index];

              return (
                <tr key={id}>
                  <th scope="row"><span className={`sensor-key sensor-${index}`}>{id}</span></th>
                  <td>{SENSOR_POSITION_M[index]} м</td>
                  <td>{measuredValue(sample?.valueSI, flow)}</td>
                  <td>{measuredValue(run?.prediction[index], flow)}</td>
                  <td>{sample ? QUALITY[sample.quality] : '—'}</td>
                  {showResidual ? <td>{residual == null ? '—' : `${NUMBER.format(residual / 1000)} кПа`}</td> : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function App() {
  const [store] = useState(createRunStore);
  const [speed, setSpeed] = useState(1);
  const [profileId, setProfileId] = useState<ProfileId>(TURBULENT_PROFILE);
  const [chartView, setChartView] = useState<ChartView>('pressure');
  const [coordinateM, setCoordinateM] = useState(DEFAULT_POSITION_M);
  const [invalidCoordinateDraft, setInvalidCoordinateDraft] = useState<string | null>(null);
  const [optimisticLeak, setOptimisticLeak] = useState(false);
  const [startup, setStartup] = useState<'live' | 'replay' | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [formGeneration, setFormGeneration] = useState(0);
  const [guided, setGuided] = useState(false);
  const [walking, setWalking] = useState(false);
  const walkOpener = useRef<HTMLButtonElement>(null);
  const [leakAppliedAtUs, setLeakAppliedAtUs] = useState<number | null>(null);
  const client = useRef<RunClient | null>(null);
  const activeRun = useRef(0);
  const revealOrigin = useRef<HTMLButtonElement | null>(null);
  const revealHeading = useRef<HTMLHeadingElement>(null);
  const resetPipeView = useRef<(() => void) | null>(null);
  const { run, trend } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const thermal = profileId === 'synthetic-oil-thermal-v1';
  const challenge = profileId === TURBULENT_PROFILE;
  const mode = MODE_COPY[profileId];
  const walkPressures = walking && !thermal ? Object.fromEntries(PRESSURE_IDS.flatMap((id) => {
    const sample = run?.samples.findLast((measurement) => measurement.sensorId === id);
    return sample?.quality === 'valid' && sample.valueSI != null && Number.isFinite(sample.valueSI)
      ? [[id, sample.valueSI]] : [];
  })) : {};
  const defenseHome = defenseHomeLink(window.location.pathname);
  const leakSubmitted = optimisticLeak || run?.leakStatus === 'pending' || run?.leakStatus === 'applied';
  const responseTimeUs = run?.leakStatus === 'applied' && leakAppliedAtUs !== null
    && run.residualTimeUs !== null && run.residualTimeUs >= leakAppliedAtUs
    && run.residualPa.some(value => value !== null) ? run.residualTimeUs : null;
  const canPlanLeak = challenge && startup !== 'replay' && !leakSubmitted
    && (!run || (!run.replaying && (run.phase === 'warming-up' || run.phase === 'running')));

  const closeCurrent = useCallback(() => {
    activeRun.current++;
    client.current?.close();
    client.current = null;
  }, []);

  useEffect(() => closeCurrent, [closeCurrent]);

  useEffect(() => {
    const origin = revealOrigin.current;
    if (!origin) return;
    if (!revealHeading.current) {
      if (run?.message && (run.phase === 'completed' || run.phase === 'invalid' || run.phase === 'error')) {
        revealOrigin.current = null;
      }
      return;
    }
    revealOrigin.current = null;
    if (document.activeElement !== origin && document.activeElement !== document.body) return;
    revealHeading.current.focus({ preventScroll: true });
    revealHeading.current.scrollIntoView({ block: 'center' });
  }, [run?.truth, run?.replay, run?.message, run?.phase]);

  function reset() {
    closeCurrent();
    revealOrigin.current = null;
    store.reset();
    setStartup(null);
    setStartupError(null);
    setOptimisticLeak(false);
    setGuided(false);
    setLeakAppliedAtUs(null);
    selectCoordinate(DEFAULT_POSITION_M);
    setFormGeneration((value) => value + 1);
  }

  function start(replay?: ReturnType<typeof parseReplay>, pace = speed) {
    if (client.current) return;

    const runNumber = ++activeRun.current;
    if (replay) changeProfile(replay.profileId);
    setStartup(replay ? 'replay' : 'live');
    setStartupError(null);

    try {
      client.current = startRun(replay?.profileId ?? profileId, (snapshot) => {
        if (activeRun.current !== runNumber) return;
        store.update(snapshot);
        if (snapshot.leakStatus !== 'idle') setOptimisticLeak(false);
        if (snapshot.leakStatus === 'applied' && snapshot.appliedTimeUs !== null) {
          setLeakAppliedAtUs((recorded) => recorded ?? snapshot.appliedTimeUs);
        }
        setStartup(null);
      }, { pace, replay });
    } catch (error) {
      setStartup(null);
      setStartupError(error instanceof Error ? error.message : 'Не удалось запустить расчёт.');
    }
  }

  function changeProfile(profile: ProfileId) {
    if (profile !== profileId) setChartView('pressure');
    setProfileId(profile);
  }

  async function importReplay(file: File) {
    if (client.current || startup !== null) return;

    const runNumber = ++activeRun.current;
    setStartupError(null);

    if (file.size > MAX_IMPORT_BYTES) {
      setStartupError('Файл повтора превышает 32 МиБ.');
      return;
    }

    setStartup('replay');
    try {
      const replay = parseReplay(await file.text());
      if (activeRun.current === runNumber) start(replay);
    } catch {
      if (activeRun.current !== runNumber) return;
      setStartup(null);
      setStartupError('Не удалось прочитать повтор. Проверьте формат и версию файла.');
    }
  }

  function changeSpeed(pace: number) {
    setSpeed(pace);
    client.current?.setPace(pace);
  }

  function selectCoordinate(positionM: number) {
    setCoordinateM(positionM);
    setInvalidCoordinateDraft(null);
  }

  function editCoordinate(positionM: number, value: string) {
    if (positionM === snapPipePosition(positionM, LEAK_GRID_STEP_M)) selectCoordinate(positionM);
    else setInvalidCoordinateDraft(value);
  }

  function inject(positionM: number, cdAreaM2: number, openingUs: number) {
    if (!client.current || leakSubmitted) return;

    client.current.injectLeak(positionM, cdAreaM2, openingUs);
    setOptimisticLeak(true);
    selectCoordinate(DEFAULT_POSITION_M);
  }

  return (
    <>
      <a className="skip-link" href="#main">К содержанию</a>
      <header className="masthead workspace-glass">
        <div className="site-width masthead-inner">
          <a href={defenseHome ?? '#main'} className="brand"
            aria-label={defenseHome ? 'OilLine Watch · к материалам' : 'OilLine Watch · к началу'}
            title={defenseHome ? 'К материалам' : undefined}>
            <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
            <span>OilLine <span className="brand-accent">Watch</span></span>
          </a>
          <a className="masthead-mode" href={forecastLink('degradation.html')}>Прогноз толщины <span aria-hidden="true">↗</span></a>
          <nav aria-label="Разделы стенда" className="masthead-nav">
            <button type="button" className="masthead-walk" ref={walkOpener} aria-haspopup="dialog" onClick={() => setWalking(true)}>
              Обход в 3D <span aria-hidden="true">↗</span>
            </button>
            <a href="#pipe">3D-участок</a>
            <a href="#operation-title">Сценарий</a>
            <a href="#telemetry">Телеметрия</a>
            {challenge ? <a href="#diagnosis">Диагностика</a> : null}
          </nav>
        </div>
      </header>

      <main className="site-width main" id="main" tabIndex={-1}>
        <div className="page-heading">
          <div>
            <p className="profile-caption">Синтетический эксперимент</p>
            <h1>{mode.title}</h1>
            <p>{mode.description}</p>
          </div>
          <Status run={run} startup={startup} challenge={challenge} runningLabel={mode.runningLabel} />
        </div>

        {startupError ? <p className="notice notice-error" role="alert">{startupError}</p> : null}
        {run?.message ? <p className="notice" role="status">{run.message}</p> : null}
        <div className="layout">
          <PipeView
            editable={canPlanLeak}
            gridStepM={profileId === 'synthetic-oil-laminar-v1' ? 10 : LEAK_GRID_STEP_M}
            showPressureSensors={!thermal}
            pendingPositionM={coordinateM}
            revealedPositionM={run?.truth?.positionM ?? null}
            residualPa={responseTimeUs === null ? null : run?.residualPa ?? null}
            onSelect={selectCoordinate}
            resetViewRef={resetPipeView}
            guide={challenge && startup !== 'replay' ? (
              <PipeDemoGuide
                run={run} starting={startup !== null} guided={guided} leakSubmitted={leakSubmitted}
                responseTimeUs={responseTimeUs}
                onStart={() => { setGuided(true); setSpeed(4); start(undefined, 4); }}
                onShowResidual={() => { setChartView('residual'); }}
              />
            ) : null}
          />
          <Controls
            key={formGeneration}
            run={run}
            starting={startup !== null}
            profileId={profileId}
            onProfileChange={changeProfile}
            speed={speed}
            coordinateM={coordinateM}
            invalidCoordinateDraft={invalidCoordinateDraft}
            leakSubmitted={leakSubmitted}
            onStart={() => { start(); }}
            onTogglePause={() => {
              if (run?.phase === 'paused') client.current?.resume();
              else client.current?.pause();
            }}
            onReset={reset}
            onSpeed={changeSpeed}
            onCoordinate={editCoordinate}
            onInject={inject}
            onShowResidual={() => { setChartView('residual'); }}
            onSetOutletFlow={(flow) => { client.current?.setOutletFlow(flow); }}
            onSetSensorFault={(sensorId, fault) => { client.current?.setSensorFault(sensorId, fault); }}
            onReveal={(button) => {
              if (!client.current) return;
              button.focus({ preventScroll: true });
              revealOrigin.current = button;
              client.current.reveal();
            }}
            onImport={(file) => { void importReplay(file); }}
            onExport={() => { if (run?.replay) downloadReplay(run.replay); }}
          />

          <div className="main-stack">
            <TimeSeriesCanvas
              trend={trend}
              thermalOnly={thermal}
              showResidual={challenge}
              view={thermal ? 'temperature' : chartView}
              onViewChange={setChartView}
              revealLink={guided && !run?.replay && run?.leakStatus === 'applied' && (
                run.phase === 'completed' || run.phase === 'invalid'
                || ((run.phase === 'running' || run.phase === 'paused') && responseTimeUs !== null)
              )}
            />
            {thermal ? null : <SensorTable run={run} showResidual={challenge} />}
            {challenge ? (
              <div className="detail-grid">
                <DiagnosticPanel run={run} revealHeading={revealHeading} onShowPipe={() => resetPipeView.current?.()} />
                <ThermalPanel run={run} />
              </div>
            ) : <ThermalPanel run={run} />}
          </div>
        </div>

        <footer className="page-footer">
          <span>OilLine Watch</span>
          <span>Данные синтетического эксперимента</span>
        </footer>
      </main>
      {walking ? <WalkDialog opener={walkOpener} pressures={walkPressures} onClose={() => setWalking(false)} /> : null}
    </>
  );
}
