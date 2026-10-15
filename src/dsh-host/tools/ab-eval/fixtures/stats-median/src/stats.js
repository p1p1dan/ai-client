/**
 * Descriptive statistics over arrays of finite numbers.
 * Every function throws a RangeError for an empty array.
 */

function assertNotEmpty(values, name) {
  if (values.length === 0) throw new RangeError(`${name}() needs at least one value`);
}

export function mean(values) {
  assertNotEmpty(values, 'mean');
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

export function median(values) {
  assertNotEmpty(values, 'median');
  const sorted = [...values].sort();
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function range(values) {
  assertNotEmpty(values, 'range');
  return Math.max(...values) - Math.min(...values);
}
