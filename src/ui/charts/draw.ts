import { decimate, type ChartPoint } from './decimate';

export interface ChartSeries {
  readonly label: string;
  readonly color: string;
  readonly dashed?: boolean;
  readonly points: readonly ChartPoint[];
}

interface ChartOptions {
  readonly series: readonly ChartSeries[];
  readonly unit: string;
  readonly endS: number;
  readonly defaultRange: readonly [number, number];
  readonly minSpan: number;
  readonly referenceZero?: boolean;
}

const WINDOW_S = 40;
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const residualNumber = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

function yRange({ series, defaultRange, minSpan, referenceZero }: ChartOptions): readonly [number, number] {
  let min = Infinity;
  let max = -Infinity;

  for (const line of series) {
    for (const point of line.points) {
      if (point.value === null || !Number.isFinite(point.value)) continue;
      min = Math.min(min, point.value);
      max = Math.max(max, point.value);
    }
  }

  if (!Number.isFinite(min)) return defaultRange;

  if (referenceZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }

  const midpoint = (min + max) / 2;
  const halfSpan = Math.max(minSpan / 2, (max - min) * 0.6);
  return [midpoint - halfSpan, midpoint + halfSpan];
}

export function drawChart(canvas: HTMLCanvasElement, options: ChartOptions) {
  const { width, height } = canvas.getBoundingClientRect();
  if (width === 0 || height === 0) return;

  const scale = window.devicePixelRatio;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return;

  context.scale(scale, scale);
  const left = 52;
  const right = width - 17;
  const top = 24;
  const bottom = height - 31;
  const endS = Math.max(WINDOW_S, options.endS);
  const startS = endS - WINDOW_S;
  const [low, high] = yRange(options);
  const x = (seconds: number) => left + (seconds - startS) / WINDOW_S * (right - left);
  const y = (value: number) => bottom - (value - low) / (high - low) * (bottom - top);
  const zeroY = options.referenceZero ? y(0) : null;

  context.font = '11px ui-monospace, monospace';
  context.lineWidth = 1;
  context.fillStyle = '#566b7b';
  context.strokeStyle = '#d7e1e9';
  context.fillText(options.unit, 3, 12);
  context.textAlign = 'right';
  context.fillText('с', left - 8, height - 9);

  for (let row = 0; row <= 4; row++) {
    const value = low + (high - low) * row / 4;
    const position = y(value);
    if (zeroY !== null && Math.abs(position - zeroY) < 12) continue;
    context.textAlign = 'right';
    context.fillText((options.referenceZero ? residualNumber : number).format(value), left - 8, position + 4);
    context.beginPath();
    context.moveTo(left, position);
    context.lineTo(right, position);
    context.stroke();
  }

  if (zeroY !== null) {
    context.save();
    context.textAlign = 'right';
    context.fillStyle = '#405c70';
    context.strokeStyle = '#758a9a';
    context.setLineDash([4, 3]);
    context.fillText('0', left - 8, zeroY + 4);
    context.beginPath();
    context.moveTo(left, zeroY);
    context.lineTo(right, zeroY);
    context.stroke();
    context.restore();
  }

  for (let column = 0; column <= 4; column++) {
    const seconds = startS + WINDOW_S * column / 4;
    const position = x(seconds);
    context.textAlign = 'center';
    context.fillText(number.format(seconds), position, height - 9);
    context.beginPath();
    context.moveTo(position, top);
    context.lineTo(position, bottom);
    context.stroke();
  }

  context.save();
  context.beginPath();
  context.rect(left, top, right - left, bottom - top);
  context.clip();

  for (const line of options.series) {
    context.beginPath();
    context.strokeStyle = line.color;
    context.lineWidth = line.dashed ? 1 : 1.7;
    context.setLineDash(line.dashed ? [5, 4] : []);
    let connected = false;

    for (const point of decimate(line.points, Math.max(1, Math.floor(right - left)), startS, endS)) {
      if (point.value === null || !Number.isFinite(point.value)) {
        connected = false;
        continue;
      }

      const px = x(point.timeS);
      const py = y(point.value);
      if (connected) context.lineTo(px, py);
      else context.moveTo(px, py);
      connected = true;
    }

    context.stroke();
  }

  context.restore();
}
