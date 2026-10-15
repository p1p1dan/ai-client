/** Descriptive statistics for the report: mean and spread over a few runs. */

export interface Spread {
  n: number;
  mean: number;
  /** Sample standard deviation (n - 1); 0 for a single value. */
  sd: number;
  median: number;
  min: number;
  max: number;
}

export function spread(values: readonly number[]): Spread | undefined {
  const finite = values.filter((value) => Number.isFinite(value));
  const n = finite.length;
  if (n === 0) return undefined;
  const mean = finite.reduce((sum, value) => sum + value, 0) / n;
  const variance =
    n > 1 ? finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : 0;
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  return {
    n,
    mean,
    sd: Math.sqrt(variance),
    median: n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    min: sorted[0],
    max: sorted[n - 1],
  };
}

/** A number with at most `digits` decimals, without trailing zeros. */
export function fmt(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return String(Math.round(value * 10 ** digits) / 10 ** digits);
}

/** `mean ± sd`, or `—` when there is nothing to summarize. */
export function meanSd(values: readonly number[], digits = 1): string {
  const s = spread(values);
  if (!s) return '—';
  return s.n > 1 ? `${fmt(s.mean, digits)} ± ${fmt(s.sd, digits)}` : fmt(s.mean, digits);
}

/** Large counts in thousands: `12.3k`. */
export function kilo(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.abs(value) >= 1000 ? `${fmt(value / 1000, 1)}k` : fmt(value, 0);
}

/** `mean ± sd` of large counts, in thousands. */
export function meanSdKilo(values: readonly number[]): string {
  const s = spread(values);
  if (!s) return '—';
  return s.n > 1 ? `${kilo(s.mean)} ± ${kilo(s.sd)}` : kilo(s.mean);
}
