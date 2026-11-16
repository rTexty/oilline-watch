import { useId, useRef, useState, type FormEvent } from 'react';
import type { ProfileId } from '../contracts/model';
import { sensorIdSchema } from '../contracts/public';
import type { SensorId } from '../contracts/public';
import type { RunSnapshot } from '../app/worker-client';
import type { ReplaySensorFault } from '../runtime/replay-schema';
import { formatTime } from './Status';
import { LEAK_GRID_STEP_M, PIPE_LENGTH_M } from './pipe-3d';

export const DEFAULT_OUTLET_FLOW_M3S = 0.02513274122871835;

const MODES = [
  { id: 'synthetic-oil-turbulent-v1', label: 'Испытание утечки', detail: 'Турбулентный поток' },
  { id: 'synthetic-oil-laminar-v1', label: 'Ламинарный опыт', detail: 'Модель памяти Zielke' },
  { id: 'synthetic-oil-thermal-v1', label: 'Тепловой опыт', detail: 'Теплообмен нефти и стенки' },
] as const;

interface ControlsProps {
  readonly run: RunSnapshot | null;
  readonly starting: boolean;
  readonly profileId: ProfileId;
  readonly onProfileChange: (profile: ProfileId) => void;
  readonly speed: number;
  readonly coordinateM: number;
  readonly invalidCoordinateDraft: string | null;
  readonly leakSubmitted: boolean;
  readonly onStart: () => void;
  readonly onTogglePause: () => void;
  readonly onReset: () => void;
  readonly onSpeed: (speed: number) => void;
  readonly onCoordinate: (coordinateM: number, draft: string) => void;
  readonly onInject: (positionM: number, cdAreaM2: number, openingUs: number) => void;
  readonly onShowResidual: () => void;
  readonly onSetOutletFlow: (flowM3s: number) => void;
  readonly onSetSensorFault: (sensorId: SensorId, fault: ReplaySensorFault) => void;
  readonly onReveal: (button: HTMLButtonElement) => void;
  readonly onImport: (file: File) => void;
  readonly onExport: () => void;
}

export function Controls(props: ControlsProps) {
  const {
    run, starting, profileId, onProfileChange, speed, coordinateM, invalidCoordinateDraft, leakSubmitted, onStart, onTogglePause, onReset, onSpeed,
    onCoordinate, onInject, onShowResidual, onSetOutletFlow, onSetSensorFault, onReveal, onImport, onExport,
  } = props;
  const fileInput = useRef<HTMLInputElement>(null);
  const profileSelectId = useId();
  const thermal = profileId === 'synthetic-oil-thermal-v1';
  const challenge = profileId === 'synthetic-oil-turbulent-v1';
  const openingId = useId();
  const positionId = useId();
  const positionErrorId = useId();
  const areaId = useId();
  const flowId = useId();
  const faultSensorId = useId();
  const faultTypeId = useId();
  const [areaUnits, setAreaUnits] = useState(1);
  const [openingS, setOpeningS] = useState(0);
  const [flowPercent, setFlowPercent] = useState(100);
  const [sensor, setSensor] = useState<SensorId>('P2');
  const [fault, setFault] = useState<ReplaySensorFault['kind']>('dropout');
  const running = run?.phase === 'running';
  const canEditChallenge = running && run.armedAtUs !== null && !run.replaying;
  const paused = run?.phase === 'paused';
  const canPause = running || paused || run?.phase === 'warming-up' || run?.phase === 'replay-wait';
  const leakPending = leakSubmitted && run?.leakStatus !== 'applied';
  const canReveal = run?.armedAtUs != null
    && (run.phase === 'completed' || (!run.replaying && !leakPending && (running || paused || run.phase === 'invalid')));
  const warmupSeconds = Math.max(0, Math.ceil((30_000_000 - (run?.timeUs ?? 0)) / 1_000_000));
  const invalidCoordinate = invalidCoordinateDraft !== null;
  const maxPositionM = PIPE_LENGTH_M - LEAK_GRID_STEP_M;

  function submitLeak(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEditChallenge || leakSubmitted || invalidCoordinate) return;

    onInject(coordinateM, areaUnits * 1e-5, openingS * 1_000_000);
    setAreaUnits(1);
    setOpeningS(0);
  }

  function submitControl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canEditChallenge) onSetOutletFlow(DEFAULT_OUTLET_FLOW_M3S * flowPercent / 100);
  }

  function submitFault(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEditChallenge) return;
    onSetSensorFault(sensor, fault === 'bias' ? { kind: fault, offsetSI: sensor === 'Qin' ? 0.0005 : 5000 } : { kind: fault });
  }

  return (
    <aside className="side-stack" aria-label="Управление экспериментом" id="controls">
      <section className="panel operation-panel" aria-labelledby="operation-title">
        <header className="panel-heading">
          <div>
            <h2 id="operation-title" tabIndex={-1}>Сценарий</h2>
            <p>{MODES.find((mode) => mode.id === profileId)?.detail}</p>
          </div>
        </header>
        <div className="operation-body">
          <div className="action-row">
            {run ? (
              <>
                <button className="button button-primary" type="button" disabled={!canPause} onClick={onTogglePause}>
                  <span aria-hidden="true">{paused ? '▶' : 'Ⅱ'}</span> {paused ? 'Продолжить' : 'Пауза'}
                </button>
                <button className="button button-secondary" type="button" onClick={onReset}>Сброс</button>
              </>
            ) : (
              <button className="button button-primary" type="button" disabled={starting} onClick={onStart}>
                <span aria-hidden="true">▶</span> {starting ? 'Подключение…' : 'Запустить сценарий'}
              </button>
            )}
          </div>
          {challenge && canPause && !run?.replaying && !leakSubmitted ? (
            <a className="control-link" href="#leak-title">К форме утечки <span aria-hidden="true">↓</span></a>
          ) : null}
          <div className="input-row profile-picker">
            <label htmlFor={profileSelectId}>Режим</label>
            <select
              id={profileSelectId}
              value={profileId}
              disabled={run !== null || starting}
              onChange={(event) => {
                const mode = MODES.find(({ id }) => id === event.currentTarget.value);
                if (mode) onProfileChange(mode.id);
              }}
            >
              {MODES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>
          </div>
          <div className="operation-row">
            <span id="pace-label">Скорость</span>
            <div className="segmented" role="group" aria-labelledby="pace-label">
              {[1, 4].map((pace) => (
                <button key={pace} type="button" aria-pressed={speed === pace} onClick={() => { onSpeed(pace); }}>
                  {pace}×
                </button>
              ))}
            </div>
          </div>
          {!run ? (
            <div className="import-row">
              <button className="button button-secondary" type="button" disabled={starting} onClick={() => { fileInput.current?.click(); }}>
                Импорт повтора
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                aria-label="Файл повтора"
                hidden
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) onImport(file);
                }}
              />
            </div>
          ) : null}
          <p className="field-note">
            {run?.replaying
              ? 'Воспроизводится записанный сценарий.'
              : thermal
              ? 'На входе задано 60 °C. Горизонт опыта — 1 час по модели.'
              : challenge
                ? (run?.phase === 'warming-up'
                  ? `До начала испытания ${warmupSeconds} с по модели.`
                  : 'Первые 30 с модельного времени — штатный разогрев.')
                : 'Через 2 с расход на выходе снижается до 80 % от Q₀.'}
          </p>
          {run?.replayVerification ? (
            <p className="field-note" role="status">
              {run.replayVerification === 'verified' ? 'Записанные F64-испытания сверены.'
                : run.replayVerification === 'partial' ? 'Сверена доступная часть диагностического журнала.'
                : run.replayVerification === 'pending' ? 'Идёт сверка записанных F64-испытаний.'
                  : run.replayVerification === 'diverged' ? 'Повтор диагностических испытаний разошёлся с записью.'
                    : 'Воспроизводятся физика и датчики. Для сверки журнала поиска нужна исходная калибровка.'}
            </p>
          ) : null}
        </div>
      </section>

      {challenge ? (
        <>
          {run?.replaying ? null : (
            <>
              <section className="panel operation-panel" aria-labelledby="leak-title">
                <header className="panel-heading">
                  <div>
                    <h2 id="leak-title" tabIndex={-1}>Скрытая утечка</h2>
                    <p>Координата, площадь и время открытия</p>
                  </div>
                </header>
                {leakSubmitted ? (
                  <div className="operation-body">
                    <p className="event-status" role="status">
                      {run?.leakStatus === 'applied' ? 'Скрытая утечка применена' : 'Запрос на утечку отправлен'}
                    </p>
                    {run?.truth ? null : <p className="field-note">Координата и параметры откроются после завершения.</p>}
                    {run?.leakStatus === 'applied' && (
                      <a className="control-link" href="#trend-title" onClick={onShowResidual}>Смотреть невязку <span aria-hidden="true">↓</span></a>
                    )}
                  </div>
                ) : (
                  <form className="operation-body control-form" onSubmit={submitLeak}>
                    <fieldset disabled={!canEditChallenge}>
                      <div className="input-row">
                        <label htmlFor={positionId}>Координата</label>
                        <div className="input-with-unit">
                          <input
                            id={positionId}
                            type="number"
                            value={invalidCoordinateDraft ?? coordinateM}
                            min={LEAK_GRID_STEP_M}
                            max={maxPositionM}
                            step={LEAK_GRID_STEP_M}
                            aria-invalid={invalidCoordinate || undefined}
                            aria-describedby={invalidCoordinate ? positionErrorId : undefined}
                            onChange={({ currentTarget }) => { onCoordinate(currentTarget.valueAsNumber, currentTarget.value); }}
                            required
                          />
                          <span>м</span>
                        </div>
                      </div>
                      {invalidCoordinate && (
                        <p className="field-error" id={positionErrorId} role="status">
                          Введите координату от {LEAK_GRID_STEP_M} до {maxPositionM} м с шагом {LEAK_GRID_STEP_M} м.
                        </p>
                      )}
                      <div className="input-row">
                        <label htmlFor={areaId}>Эфф. площадь CdA</label>
                        <div className="input-with-unit">
                          <input
                            id={areaId}
                            type="number"
                            value={Number.isFinite(areaUnits) ? areaUnits : ''}
                            min={0.1}
                            max={4}
                            step={0.1}
                            onChange={(event) => { setAreaUnits(event.currentTarget.valueAsNumber); }}
                            required
                          />
                          <span>×10⁻⁵ м²</span>
                        </div>
                      </div>
                      <div className="input-row">
                        <label htmlFor={openingId}>Время открытия</label>
                        <select id={openingId} value={openingS} onChange={(event) => { setOpeningS(Number(event.currentTarget.value)); }}>
                          <option value={0}>Мгновенно</option>
                          <option value={1}>1 с</option>
                          <option value={20}>20 с</option>
                        </select>
                      </div>
                      <button className="button button-event" type="submit" disabled={invalidCoordinate}>Ввести утечку</button>
                    </fieldset>
                    {running ? null : <p className="field-note">Ввод утечки доступен после разогрева.</p>}
                  </form>
                )}
              </section>

              <section className="panel operation-panel" aria-labelledby="boundary-title">
                <header className="panel-heading">
                  <div>
                    <h2 id="boundary-title">Граница потока</h2>
                    <p>Публичное воздействие на обе модели</p>
                  </div>
                </header>
                <details className="sensor-fault-controls flow-adjustment">
                  <summary>Изменить расход</summary>
                  <form className="control-form" onSubmit={submitControl}>
                    <fieldset disabled={!canEditChallenge}>
                      <div className="input-row">
                        <label htmlFor={flowId}>Расход Qout</label>
                        <div className="input-with-unit">
                          <input
                            id={flowId}
                            type="number"
                            value={Number.isFinite(flowPercent) ? flowPercent : ''}
                            min={90}
                            max={110}
                            step={1}
                            onChange={(event) => { setFlowPercent(event.currentTarget.valueAsNumber); }}
                            required
                          />
                          <span>% от Q₀</span>
                        </div>
                      </div>
                      <button className="button button-secondary" type="submit">Задать расход</button>
                    </fieldset>
                  </form>
                </details>
                <details className="sensor-fault-controls">
                  <summary>Сбой датчика</summary>
                  <form className="control-form" onSubmit={submitFault}>
                    <fieldset disabled={!canEditChallenge}>
                      <div className="input-row">
                        <label htmlFor={faultSensorId}>Канал датчика</label>
                        <select id={faultSensorId} value={sensor} onChange={(event) => { setSensor(sensorIdSchema.parse(event.currentTarget.value)); }}>
                          {sensorIdSchema.options.map((id) => <option key={id}>{id}</option>)}
                        </select>
                      </div>
                      <div className="input-row">
                        <label htmlFor={faultTypeId}>Тип сбоя</label>
                        <select id={faultTypeId} value={fault} onChange={(event) => {
                          const value = event.currentTarget.value;
                          if (value === 'dropout' || value === 'stuck-zero' || value === 'bias' || value === 'clear') setFault(value);
                        }}>
                          <option value="dropout">Пропуск</option>
                          <option value="stuck-zero">Залипание на нуле</option>
                          <option value="bias">Смещение +{sensor === 'Qin' ? '0,5 л/с' : '5 кПа'}</option>
                          <option value="clear">Восстановить</option>
                        </select>
                      </div>
                      <button className="button button-secondary" type="submit">Применить к датчику</button>
                    </fieldset>
                  </form>
                </details>
              </section>
            </>
          )}
          <section className="panel operation-panel result-controls" aria-labelledby="finish-title">
            <header className="panel-heading">
              <h2 id="finish-title" tabIndex={-1}>Итог испытания</h2>
            </header>
            <div className="operation-body">
              <button
                className="button button-secondary"
                type="button"
                disabled={!canReveal || run?.replay != null}
                onClick={(event) => onReveal(event.currentTarget)}
              >
                {run?.phase === 'completed' ? 'Раскрыть сценарий' : 'Завершить и раскрыть'}
              </button>
              {run?.replay ? (
                <>
                  <button className="button button-secondary replay-export" type="button" onClick={onExport}>
                    Экспорт повтора
                  </button>
                  <p className="field-note">Файл содержит скрытые события и начальное состояние генератора.</p>
                </>
              ) : null}
              {run?.appliedTimeUs == null ? null : (
                <p className="field-note">Последняя команда применена в {formatTime(run.appliedTimeUs)}.</p>
              )}
            </div>
          </section>
        </>
      ) : null}
    </aside>
  );
}
