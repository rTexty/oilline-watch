import type { RunSnapshot } from './worker-client';

export const PRESSURE_SENSOR_IDS = ['P1', 'P2', 'P3'] as const;
export const SENSOR_IDS = [...PRESSURE_SENSOR_IDS, 'Qin'] as const;

export interface TrendPoint {
  readonly timeUs: number;
  readonly residualTimeUs: number | null;
  readonly pressureBar: readonly (number | null)[];
  readonly predictionBar: readonly (number | null)[];
  readonly residualKpa: readonly (number | null)[];
  readonly temperaturesC: readonly (number | null)[];
}

interface AppSnapshot {
  readonly run: RunSnapshot | null;
  readonly trend: readonly TrendPoint[];
}

const MAX_TREND_POINTS = 800;
const TREND_WINDOW_US = 40_000_000;
const INITIAL: AppSnapshot = { run: null, trend: [] };

function toPoint(run: RunSnapshot): TrendPoint {
  const pressure = PRESSURE_SENSOR_IDS.map((id) =>
    run.samples.findLast((sample) =>
      sample.sensorId === id && sample.quality === 'valid' && sample.sampleTimeUs === run.timeUs,
    )?.valueSI ?? null,
  );

  return {
    timeUs: run.timeUs,
    residualTimeUs: run.residualTimeUs,
    pressureBar: pressure.map((value) => value === null ? null : value / 100_000),
    predictionBar: PRESSURE_SENSOR_IDS.map((_, index) => {
      const pressurePa = run.prediction[index];
      return pressurePa === undefined ? null : pressurePa / 100_000;
    }),
    residualKpa: PRESSURE_SENSOR_IDS.map((_, index) => {
      const pressurePa = run.residualPa[index];
      return pressurePa == null ? null : pressurePa / 1_000;
    }),
    temperaturesC: [run.temperatures.oilInK, run.temperatures.oilOutK, run.temperatures.wallOutK]
      .map((value) => value - 273.15),
  };
}

export function createRunStore() {
  const listeners = new Set<() => void>();
  let current = INITIAL;

  function publish(snapshot: AppSnapshot) {
    current = snapshot;
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(run: RunSnapshot) {
      if (current.run && run.timeUs < current.run.timeUs) return;

      const hasNewTime = run.timeUs !== current.run?.timeUs;
      const cutoffUs = run.timeUs - TREND_WINDOW_US;
      const trend = hasNewTime
        ? [...current.trend.filter((point) => point.timeUs >= cutoffUs).slice(-(MAX_TREND_POINTS - 1)), toPoint(run)]
        : current.trend;

      publish({ run, trend });
    },
    reset() {
      publish(INITIAL);
    },
  };
}
