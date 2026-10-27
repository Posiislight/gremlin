import type { MetricPoint } from '../types';

export type MetricKey =
  | 'tokens'
  | 'costUsd'
  | 'wallMs'
  | 'stepsPerFinding'
  | 'falsePositiveRate'
  | 'confirmed'
  | 'regressionCatches';

/** For these, a decrease is an improvement. */
const LOWER_IS_BETTER: Record<MetricKey, boolean> = {
  tokens: true,
  costUsd: true,
  wallMs: true,
  stepsPerFinding: true,
  falsePositiveRate: true,
  confirmed: false,
  regressionCatches: false,
};

export type MetricDelta = {
  key: MetricKey;
  current: number;
  previous: number | null;
  delta: number | null;
  pct: number | null;
  improved: boolean | null;
};

export function metricDelta(points: readonly MetricPoint[], key: MetricKey): MetricDelta {
  const cur = points[points.length - 1];
  const prev = points[points.length - 2];
  const current = cur ? cur[key] : 0;
  if (!prev) return { key, current, previous: null, delta: null, pct: null, improved: null };
  const previous = prev[key];
  const delta = current - previous;
  const pct = previous === 0 ? null : delta / previous;
  const improved = delta === 0 ? null : LOWER_IS_BETTER[key] ? delta < 0 : delta > 0;
  return { key, current, previous, delta, pct, improved };
}

export function sparkPath(values: readonly number[], w: number, h: number, pad = 2): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x = values.length === 1 ? w / 2 : pad + (i / (values.length - 1)) * (w - pad * 2);
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
