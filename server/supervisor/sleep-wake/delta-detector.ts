import type { DeltaResult } from './types';

function normalise(name: string): string {
  return name.toLowerCase().replace(/^the\s+/i, '').trim();
}

export function detectDelta(
  baselineNames: string[],
  currentNames: string[],
): DeltaResult {
  const baselineSet = new Set(baselineNames.map(normalise));
  const currentSet = new Set(currentNames.map(normalise));

  const newEntities = currentNames.filter(n => !baselineSet.has(normalise(n)));
  const removedEntities = baselineNames.filter(n => !currentSet.has(normalise(n)));
  const unchangedCount = currentNames.filter(n => baselineSet.has(normalise(n))).length;

  return {
    newEntities,
    removedEntities,
    unchangedCount,
    baselineCount: baselineNames.length,
    currentCount: currentNames.length,
  };
}
