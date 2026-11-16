import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode, type Ref } from 'react';
import { createPipeRenderer, findPipePosition, orbitPipe, PIPE_LENGTH_M, PRESSURE_STATIONS, projectPipeAnchors, snapPipePosition, zoomPipe, type Camera } from './pipe-3d';
import { formatPressureDelta } from './PipeDemoGuide';
import { CAMERA_VIEWS, usePipeCamera } from './use-pipe-camera';

const PIPE_LEFT = 40;
const PIPE_RIGHT = 760;
const LENGTH_M = PIPE_LENGTH_M;
const TICKS = [0, 250, 500, 750, 1000];
const pipeX = (positionM: number) => PIPE_LEFT + (PIPE_RIGHT - PIPE_LEFT) * positionM / LENGTH_M;

function SceneAnnotations({ camera, width, height, sensors, revealedPositionM, residualPa }: {
  readonly camera: Camera;
  readonly width: number;
  readonly height: number;
  readonly sensors: boolean;
  readonly revealedPositionM: number | null;
  readonly residualPa: readonly (number | null)[] | null;
}) {
  if (width === 0 || height === 0) return null;
  const labelled = projectPipeAnchors(camera, width / height, sensors, revealedPositionM)
    .map((anchor) => {
      const leak = anchor.id === 'leak';
      const halfWidth = leak ? 30 : residualPa && width >= 520 ? 62 : 20;
      const x = anchor.x * width;
      const left = leak ? Math.max(halfWidth + 5, Math.min(width - halfWidth - 5, x)) : x;
      return { ...anchor, halfWidth, x, left, y: anchor.y * height };
    });

  const visible: typeof labelled = [];
  for (const anchor of labelled) {
    if (anchor.x < 0 || anchor.x > width || anchor.y < 40 || anchor.y > height - 1) continue;
    if (anchor.left < anchor.halfWidth + 4 || width - anchor.left < anchor.halfWidth + 4) continue;
    if (visible.some((other) => Math.abs(anchor.left - other.left) < anchor.halfWidth + other.halfWidth + 5
      && Math.abs(anchor.y - other.y) < 33)) continue;
    visible.push(anchor);
  }

  return (
    <div className="pipe-annotations" data-testid="pipe-scene-annotations" aria-hidden="true">
      {visible.map(({ id, x, left, y }) => {
        const stationIndex = PRESSURE_STATIONS.findIndex(({ label }) => label === id);
        const station = PRESSURE_STATIONS[stationIndex];
        const residual = width >= 520 ? residualPa?.[stationIndex] : null;
        return (
          <span key={id} className={station ? `pipe-anchor pipe-anchor-${id.toLowerCase()}` : 'pipe-anchor pipe-anchor-leak'}
            data-testid={station ? undefined : 'pipe-reveal-anchor'}
            style={{ left, top: y }}>
            <b>{station ? station.label : 'Утечка'}</b>
            {residual == null ? null : <span>ΔP {formatPressureDelta(residual)}</span>}
            <i style={{ left: `calc(50% + ${x - left}px)` }} />
          </span>
        );
      })}
    </div>
  );
}

export function PipeView({
  editable,
  gridStepM,
  showPressureSensors,
  pendingPositionM,
  revealedPositionM,
  residualPa,
  onSelect,
  guide,
  resetViewRef,
}: {
  readonly editable: boolean;
  readonly gridStepM: number;
  readonly showPressureSensors: boolean;
  readonly pendingPositionM: number | null;
  readonly revealedPositionM: number | null;
  readonly residualPa: readonly (number | null)[] | null;
  readonly onSelect: (positionM: number) => void;
  readonly guide?: ReactNode;
  readonly resetViewRef?: Ref<() => void>;
}) {
  const svgTitle = useId();
  const svgDescription = useId();
  const pipeGradient = useId();
  const gridPattern = useId();
  const position = revealedPositionM ?? (editable && pendingPositionM !== null ? snapPipePosition(pendingPositionM, gridStepM) : null);
  const { camera, view, stop, adjust, reset, select: selectView } = usePipeCamera();
  useImperativeHandle(resetViewRef, () => reset, [reset]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [fallback, setFallback] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const renderer = useRef<ReturnType<typeof createPipeRenderer>>(null);
  const gesture = useRef<{
    id: number; x: number; y: number; intent: 'tap' | 'orbit' | 'scroll';
  } | null>(null);
  const frame = useRef({ camera, sensors: showPressureSensors, position, revealed: revealedPositionM !== null });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || fallback) return;
    const canvasElement = canvas;
    let observer: ResizeObserver | undefined;
    let active = true;
    function showFallback() {
      queueMicrotask(() => { if (active) setFallback(true); });
    }
    function draw() {
      const current = frame.current;
      const { width, height } = canvasElement.getBoundingClientRect();
      setSize((previous) => previous.width === width && previous.height === height ? previous : { width, height });
      renderer.current?.draw(current.camera, { sensors: current.sensors, positionM: current.position, revealed: current.revealed });
    }
    function contextLost(event: Event) {
      event.preventDefault();
      stop();
      if (document.activeElement?.closest('.pipe-camera-controls')) headingRef.current?.focus({ preventScroll: true });
      showFallback();
    }
    try {
      renderer.current = createPipeRenderer(canvas);
      if (renderer.current) {
        canvas.addEventListener('webglcontextlost', contextLost);
        observer = new ResizeObserver(draw);
        observer.observe(canvas);
        draw();
      } else {
        showFallback();
      }
    } catch {
      showFallback();
    }
    return () => {
      active = false;
      observer?.disconnect();
      canvas.removeEventListener('webglcontextlost', contextLost);
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [fallback, stop]);

  useLayoutEffect(() => {
    frame.current = { camera, sensors: showPressureSensors, position, revealed: revealedPositionM !== null };
    renderer.current?.draw(camera, { sensors: showPressureSensors, positionM: position, revealed: revealedPositionM !== null });
  }, [camera, position, revealedPositionM, showPressureSensors]);

  function beginOrbit(event: PointerEvent<HTMLCanvasElement>) {
    if (gesture.current) {
      if (event.pointerType === 'touch' && gesture.current.id !== event.pointerId) gesture.current = null;
      return;
    }
    if (event.button !== 0 || !event.isPrimary) return;
    stop();
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, intent: 'tap' };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function cancelOrbit(event: PointerEvent<HTMLCanvasElement>) {
    if (gesture.current?.id === event.pointerId) gesture.current = null;
  }

  function moveOrbit(event: PointerEvent<HTMLCanvasElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId || current.intent === 'scroll') return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.intent === 'tap' && Math.hypot(dx, dy) < 5) return;
    const touch = event.pointerType === 'touch';
    if (current.intent === 'tap' && touch && Math.abs(dy) >= Math.abs(dx)) {
      gesture.current = { ...current, intent: 'scroll' };
      return;
    }
    gesture.current = { ...current, x: event.clientX, y: event.clientY, intent: 'orbit' };
    adjust((currentCamera) => orbitPipe(currentCamera, dx, touch ? 0 : dy));
  }

  function finishOrbit(event: PointerEvent<HTMLCanvasElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    gesture.current = null;
    if (!editable || current.intent !== 'tap' || Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 5) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!(bounds.width > 0 && bounds.height > 0)) return;
    const u = 2 * (event.clientX - bounds.left) / bounds.width - 1;
    const v = 1 - 2 * (event.clientY - bounds.top) / bounds.height;
    const selected = findPipePosition(camera, bounds.width / bounds.height, u, v);
    if (selected !== null) onSelect(snapPipePosition(selected, gridStepM));
  }

  function select(event: MouseEvent<SVGRectElement>) {
    if (!editable) return;

    const target = event.currentTarget;
    const bounds = target.getBoundingClientRect();
    if (bounds.width <= 0) return;

    const fraction = (event.clientX - bounds.left) / bounds.width;
    onSelect(snapPipePosition(fraction * LENGTH_M, gridStepM));
  }

  return (
    <section className="panel pipe-panel" id="pipe" aria-labelledby="pipe-title" data-revealed={revealedPositionM !== null}>
      <header className="panel-heading">
        <div>
          <h2 ref={headingRef} id="pipe-title" tabIndex={-1}>Модель участка</h2>
          <p>1 000 м <span aria-hidden="true">/</span> внутренний диаметр 200 мм</p>
        </div>
        {showPressureSensors ? <span className="pipe-channel-count">3 датчика давления</span> : null}
      </header>
      {fallback ? (
      <svg className="pipe-diagram" data-testid="pipe-2d-fallback" viewBox="0 0 800 154" role="img" aria-labelledby={`${svgTitle} ${svgDescription}`}>
        <title id={svgTitle}>Участок нефтепровода, 1000 м</title>
        <desc id={svgDescription}>{showPressureSensors
          ? 'P1 на 100 м, P2 на 500 м, P3 на 900 м. Qin на входе. Для выбора координаты с клавиатуры используйте поле управления.'
          : 'Участок теплового опыта с входом и выходом нефти.'}</desc>
        <defs>
          <linearGradient id={pipeGradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#658199" />
            <stop offset=".48" stopColor="#738da2" />
            <stop offset="1" stopColor="#526c80" />
          </linearGradient>
          <pattern id={gridPattern} width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke="#34515f" strokeWidth=".5" />
          </pattern>
        </defs>
        <rect x="0" y="0" width="800" height="154" rx="8" fill={`url(#${gridPattern})`} />
        <rect x={PIPE_LEFT} y="64" width={PIPE_RIGHT - PIPE_LEFT} height="27" rx="12" fill={`url(#${pipeGradient})`} stroke="#526a7e" />
        <path d="M52 77H748" stroke="#54778c" opacity=".55" strokeDasharray="4 7" />
        <path d="M183 73L190 77L183 81M333 73L340 77L333 81M483 73L490 77L483 81M633 73L640 77L633 81" fill="none" stroke="#376a89" opacity=".75" />
        <path d="M40 61V94M760 61V94" stroke="#56758c" strokeWidth="3" />
        <g fill="#adc0cb" className="pipe-label">
          <text x={PIPE_LEFT} y="47" textAnchor="middle">Qin</text>
          <text x={PIPE_RIGHT} y="47" textAnchor="middle">Qout</text>
        </g>
        {showPressureSensors && PRESSURE_STATIONS.map(({ label, locationM, color }) => (
          <g key={label} transform={`translate(${pipeX(locationM)},0)`}>
            <path d="M0 52V64" stroke={color} strokeWidth="1.5" />
            <circle cx="0" cy="43" r="7" fill="#112531" stroke={color} strokeWidth="1.5" />
            <circle cx="0" cy="43" r="2.5" fill={color} />
            <text y="27" textAnchor="middle" fill={color} className="pipe-label">{label}</text>
          </g>
        ))}
        <path d={`M${PIPE_LEFT} 112H${PIPE_RIGHT}`} stroke="#879eae" />
        {TICKS.map((tick) => (
          <g key={tick} transform={`translate(${pipeX(tick)},0)`}>
            <path d="M0 107V117" stroke="#657e90" />
            <text y="138" textAnchor="middle" fill="#adc0cb" className="pipe-tick">{tick} м</text>
          </g>
        ))}
        {position === null ? null : (
          <g transform={`translate(${pipeX(position)},0)`}>
            {revealedPositionM === null ? null : <circle cx="0" cy="77" r="16" fill="none" stroke="#ffb57a" strokeWidth="2" />}
            <path d="M0 88V106" stroke="#ffb57a" strokeDasharray="3 2" />
            <path d="M-5 98H5L0 92Z" fill="#ffb57a" />
          </g>
        )}
        <rect
          x={PIPE_LEFT} y="47" width={PIPE_RIGHT - PIPE_LEFT} height="59"
          fill="transparent" className={editable ? 'pipe-hit-target' : undefined}
          onClick={editable ? select : undefined}
        />
      </svg>
      ) : (
        <div className="pipe-viewport">
          <canvas
            ref={canvasRef}
            className="pipe-canvas"
            data-testid="pipe-3d-canvas"
            role="img"
            aria-label="Трёхмерная модель трубопровода"
            aria-describedby={showPressureSensors ? 'pipe-sensor-positions' : undefined}
            data-editable={editable}
            data-marker={position === null ? 'hidden' : revealedPositionM === null ? 'planned' : 'revealed'}
            onPointerDown={beginOrbit}
            onPointerMove={moveOrbit}
            onPointerUp={finishOrbit}
            onLostPointerCapture={cancelOrbit}
            onPointerCancel={cancelOrbit}
          />
          <SceneAnnotations camera={camera} width={size.width} height={size.height}
            sensors={showPressureSensors} revealedPositionM={revealedPositionM} residualPa={residualPa} />
          {showPressureSensors ? <span className="sr-only" id="pipe-sensor-positions">
            {PRESSURE_STATIONS.map(({ label, locationM }) => `${label} на ${locationM} м`).join(', ')}
          </span> : null}
        </div>
      )}
      {guide}
      {!fallback && (
        <div className="pipe-camera-controls">
          <div className="pipe-view-toolbar" role="group" aria-label="Камера 3D-модели">
            <button type="button" aria-label="Повернуть модель влево" onClick={() => adjust((current) => orbitPipe(current, 26, 0))}>↶</button>
            <button type="button" aria-label="Повернуть модель вправо" onClick={() => adjust((current) => orbitPipe(current, -26, 0))}>↷</button>
            <button type="button" aria-label="Приблизить модель" disabled={camera.zoom <= 0.69} onClick={() => adjust((current) => zoomPipe(current, 0.85))}>+</button>
            <button type="button" aria-label="Отдалить модель" disabled={camera.zoom >= 1.9} onClick={() => adjust((current) => zoomPipe(current, 1 / 0.85))}>−</button>
            <button type="button" aria-label="Восстановить вид" onClick={reset}>Сброс</button>
          </div>
          <div className="pipe-presets" role="group" aria-label="Ракурс 3D-модели">
            {(Object.keys(CAMERA_VIEWS) as (keyof typeof CAMERA_VIEWS)[]).map((label) => (
              <button key={label} type="button" aria-pressed={view === label} onClick={() => selectView(label)}>{label}</button>
            ))}
          </div>
        </div>
      )}
      <div className="pipe-foot">
        <span className="pipe-stage-status">{fallback ? 'Схема 2D' : <>
          <span className="pipe-orbit-mouse">Перетащите, чтобы повернуть</span>
          <span className="pipe-orbit-touch">Свайп вбок поворачивает трубу</span>
        </>}</span>
        <span>{editable ? 'Нажмите на трубу, чтобы выбрать место' : `Шаг сетки ${gridStepM} м`}</span>
      </div>
      {editable && (
        <div className="pipe-selection">
          <label htmlFor={`${svgTitle}-coord`}>{fallback ? 'Координата на схеме' : 'Координата на 3D-модели'}</label>
          <input id={`${svgTitle}-coord`} type="range" min={gridStepM} max={LENGTH_M - gridStepM} step={gridStepM}
            value={snapPipePosition(pendingPositionM ?? 500, gridStepM)} onChange={(event) => onSelect(Number(event.target.value))}
            aria-valuetext={`${snapPipePosition(pendingPositionM ?? 500, gridStepM)} м`} />
          <output htmlFor={`${svgTitle}-coord`}>{snapPipePosition(pendingPositionM ?? 500, gridStepM)} м</output>
        </div>
      )}
    </section>
  );
}
