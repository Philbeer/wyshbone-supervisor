import type { ArtefactJudgementResponse } from './tower-artefact-judge';
import { RADIUS_LADDER_KM } from './agent-loop';

export interface TowerGap {
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  detail: string;
}

export interface TowerSuggestedChange {
  field: string;
  action: 'drop' | 'relax' | 'expand' | 'increase' | 'broaden';
  reason: string;
  current_value?: unknown;
  suggested_value?: unknown;
}

export interface TowerChangePlanDirective {
  gaps: TowerGap[];
  suggested_changes: TowerSuggestedChange[];
}

export interface PlanV2Constraints {
  business_type: string;
  location: string;
  base_location: string;
  country: string;
  search_count: number;
  requested_count: number;
  requested_count_user: number | null;
  search_budget_count: number;
  prefix_filter: string | undefined;
  radius_rung: number;
  radius_km: number;
}

export interface ConstraintHardness {
  field: string;
  hardness: 'hard' | 'soft';
}

export interface PlanV2Result {
  constraints: PlanV2Constraints;
  adjustments_applied: Array<{ field: string; action: string; from: unknown; to: unknown; reason: string }>;
  strategy_summary: string;
  blocked_changes: Array<{ field: string; action: string; reason: string; blocked_reason: string }>;
  no_progress: boolean;
  cannot_expand_further: boolean;
}

export function extractChangePlanDirective(
  judgement: ArtefactJudgementResponse,
): TowerChangePlanDirective {
  const raw = judgement as unknown as Record<string, unknown>;

  let gaps: TowerGap[] = [];
  if (Array.isArray(raw.gaps)) {
    gaps = raw.gaps.map((g: any) => ({
      type: typeof g === 'string' ? g : (g.type || 'unknown'),
      severity: (typeof g === 'object' && g.severity) || 'high',
      detail: (typeof g === 'object' && g.detail) || (typeof g === 'string' ? g : ''),
    }));
  } else if (Array.isArray(judgement.reasons)) {
    gaps = judgement.reasons.map(r => ({
      type: inferGapType(r),
      severity: 'high' as const,
      detail: r,
    }));
  }

  let suggested_changes: TowerSuggestedChange[] = [];
  if (Array.isArray(raw.suggested_changes)) {
    suggested_changes = raw.suggested_changes.map((sc: any) => ({
      field: mapTowerField(sc.field),
      action: mapTowerType(sc.type, sc.action),
      reason: sc.reason || '',
      current_value: sc.current_value ?? sc.from,
      suggested_value: sc.suggested_value ?? sc.to,
    }));
  } else {
    suggested_changes = deriveChangesFromGaps(gaps);
  }

  return { gaps, suggested_changes };
}

function mapTowerField(field: string | undefined): string {
  if (!field) return 'unknown';
  const f = field.toLowerCase();
  if (f === 'prefix') return 'prefix_filter';
  if (f === 'radius') return 'location';
  return f;
}

function mapTowerType(type: string | undefined, action: string | undefined): TowerSuggestedChange['action'] {
  if (action && ['drop', 'relax', 'expand', 'increase', 'broaden'].includes(action)) {
    return action as TowerSuggestedChange['action'];
  }
  if (!type) return 'relax';
  const t = type.toUpperCase();
  if (t === 'RELAX_CONSTRAINT') return 'drop';
  if (t === 'EXPAND_AREA') return 'expand';
  if (t === 'BROADEN_QUERY') return 'broaden';
  if (t === 'CHANGE_TOOL') return 'relax';
  return 'relax';
}

function inferGapType(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes('insufficient') || lower.includes('count') || lower.includes('zero') || lower.includes('0 of')) return 'insufficient_count';
  if (lower.includes('constraint') || lower.includes('strict') || lower.includes('prefix') || lower.includes('filter')) return 'constraint_too_strict';
  if (lower.includes('location') || lower.includes('radius') || lower.includes('area')) return 'location_too_narrow';
  if (lower.includes('quality') || lower.includes('data')) return 'quality_issue';
  return 'general_gap';
}

function deriveChangesFromGaps(gaps: TowerGap[]): TowerSuggestedChange[] {
  const changes: TowerSuggestedChange[] = [];
  const gapTypes = new Set(gaps.map(g => g.type));

  if (gapTypes.has('constraint_too_strict')) {
    changes.push({
      field: 'prefix_filter',
      action: 'drop',
      reason: 'Prefix filter eliminated all results; dropping to maximise coverage',
    });
  }

  if (gapTypes.has('insufficient_count') || gapTypes.has('location_too_narrow')) {
    changes.push({
      field: 'location',
      action: 'expand',
      reason: 'Insufficient results in current area; expanding search radius',
    });
  }

  if (gapTypes.has('insufficient_count') && !gapTypes.has('constraint_too_strict')) {
    changes.push({
      field: 'search_count',
      action: 'increase',
      reason: 'Increasing maxResults to find more candidates',
    });
  }

  if (changes.length === 0) {
    changes.push({
      field: 'location',
      action: 'expand',
      reason: 'Default fallback: expand search area',
    });
  }

  return changes;
}

function expandLocationByLadder(
  baseLocation: string,
  currentRung: number,
): { location: string; newRung: number; radiusKm: number; atMax: boolean } {
  const nextRung = currentRung + 1;
  if (nextRung >= RADIUS_LADDER_KM.length) {
    return {
      location: baseLocation,
      newRung: currentRung,
      radiusKm: RADIUS_LADDER_KM[currentRung],
      atMax: true,
    };
  }

  const radiusKm = RADIUS_LADDER_KM[nextRung];
  const location = radiusKm === 0
    ? baseLocation
    : `${baseLocation} within ${radiusKm}km`;

  return { location, newRung: nextRung, radiusKm, atMax: false };
}

export function isConstraintHard(
  field: string,
  hardConstraints: string[],
): boolean {
  return hardConstraints.includes(field);
}

export function applyLeadgenReplanPolicy(
  currentConstraints: PlanV2Constraints,
  directive: TowerChangePlanDirective,
  hardConstraints: string[],
  softConstraints: string[],
  planVersion: number,
): PlanV2Result {
  const next = { ...currentConstraints };
  const adjustments: PlanV2Result['adjustments_applied'] = [];
  const blocked_changes: PlanV2Result['blocked_changes'] = [];
  let no_progress = true;
  let cannot_expand_further = false;

  for (const change of directive.suggested_changes) {
    switch (change.field) {
      case 'prefix_filter':
        if ((change.action === 'drop' || change.action === 'relax') && next.prefix_filter) {
          if (isConstraintHard('prefix_filter', hardConstraints)) {
            blocked_changes.push({
              field: 'prefix_filter',
              action: change.action,
              reason: change.reason,
              blocked_reason: 'prefix_filter is a hard constraint and cannot be relaxed',
            });
            console.log(`[REPLAN_POLICY] BLOCKED: cannot drop prefix_filter "${next.prefix_filter}" — hard constraint`);
          } else {
            adjustments.push({
              field: 'prefix_filter',
              action: 'drop',
              from: next.prefix_filter,
              to: undefined,
              reason: change.reason,
            });
            next.prefix_filter = undefined;
            no_progress = false;
          }
        }
        break;

      case 'location':
        if (change.action === 'expand') {
          if (isConstraintHard('location', hardConstraints)) {
            blocked_changes.push({
              field: 'location',
              action: 'expand',
              reason: change.reason,
              blocked_reason: 'location is a hard constraint and cannot be expanded',
            });
            console.log(`[REPLAN_POLICY] BLOCKED: cannot expand location — hard constraint`);
          } else {
            const expansion = expandLocationByLadder(
              next.base_location,
              next.radius_rung,
            );

            if (expansion.atMax) {
              cannot_expand_further = true;
              console.log(`[REPLAN_POLICY] Cannot expand further — already at max radius rung ${next.radius_rung} (${RADIUS_LADDER_KM[next.radius_rung]}km)`);
            } else {
              adjustments.push({
                field: 'location',
                action: 'expand',
                from: next.location,
                to: expansion.location,
                reason: `${change.reason} (radius ladder: ${RADIUS_LADDER_KM[next.radius_rung]}km → ${expansion.radiusKm}km)`,
              });
              next.location = expansion.location;
              next.radius_rung = expansion.newRung;
              next.radius_km = expansion.radiusKm;
              no_progress = false;
            }
          }
        }
        break;

      case 'search_count':
        if (change.action === 'increase') {
          const newCount = Math.min(60, Math.max(next.search_count, 40));
          if (newCount !== next.search_count) {
            adjustments.push({
              field: 'search_count',
              action: 'increase',
              from: next.search_count,
              to: newCount,
              reason: change.reason,
            });
            next.search_count = newCount;
            next.search_budget_count = newCount;
            no_progress = false;
          }
        }
        break;

      case 'business_type':
        if (change.action === 'broaden' && change.suggested_value) {
          if (isConstraintHard('business_type', hardConstraints)) {
            blocked_changes.push({
              field: 'business_type',
              action: 'broaden',
              reason: change.reason,
              blocked_reason: 'business_type is a hard constraint and cannot be broadened',
            });
            console.log(`[REPLAN_POLICY] BLOCKED: cannot broaden business_type — hard constraint`);
          } else {
            adjustments.push({
              field: 'business_type',
              action: 'broaden',
              from: next.business_type,
              to: change.suggested_value,
              reason: change.reason,
            });
            next.business_type = String(change.suggested_value);
            no_progress = false;
          }
        }
        break;

      case 'country':
        if (change.suggested_value && String(change.suggested_value) !== next.country) {
          adjustments.push({
            field: 'country',
            action: 'relax',
            from: next.country,
            to: change.suggested_value,
            reason: change.reason || 'Correcting country based on location',
          });
          next.country = String(change.suggested_value);
          no_progress = false;
          console.log(`[REPLAN_POLICY] Corrected country: ${adjustments[adjustments.length - 1].from} → ${next.country}`);
        }
        break;

      case 'requested_count':
        if (change.action === 'increase' && typeof change.suggested_value === 'number') {
          const newCount = Math.min(change.suggested_value as number, 200);
          if (newCount > next.requested_count) {
            adjustments.push({
              field: 'requested_count',
              action: 'increase',
              from: next.requested_count,
              to: newCount,
              reason: change.reason || 'Increasing requested count',
            });
            next.requested_count = newCount;
            no_progress = false;
          }
        }
        break;
    }
  }

  if (no_progress && !cannot_expand_further && !isConstraintHard('location', hardConstraints)) {
    const expansion = expandLocationByLadder(next.base_location, next.radius_rung);
    if (!expansion.atMax) {
      adjustments.push({
        field: 'location',
        action: 'expand',
        from: next.location,
        to: expansion.location,
        reason: 'Fallback: expanding search radius since no other adjustments were possible',
      });
      next.location = expansion.location;
      next.radius_rung = expansion.newRung;
      next.radius_km = expansion.radiusKm;
      no_progress = false;
    } else {
      cannot_expand_further = true;
    }
  }

  const strategies = adjustments.map(a => `${a.action} ${a.field}`);
  const vLabel = `v${planVersion + 1}`;
  const strategy_summary = strategies.length > 0
    ? `Plan ${vLabel}: ${strategies.join(', ')}`
    : cannot_expand_further
      ? `Plan ${vLabel}: cannot expand further — at max radius (${RADIUS_LADDER_KM[next.radius_rung]}km)`
      : `Plan ${vLabel}: no changes applied (all blocked by hard constraints)`;

  return {
    constraints: next,
    adjustments_applied: adjustments,
    strategy_summary,
    blocked_changes,
    no_progress,
    cannot_expand_further,
  };
}

export function constraintsAreIdentical(
  a: PlanV2Constraints,
  b: PlanV2Constraints,
): boolean {
  return (
    a.business_type === b.business_type &&
    a.location === b.location &&
    a.country === b.country &&
    a.search_count === b.search_count &&
    a.prefix_filter === b.prefix_filter &&
    a.radius_rung === b.radius_rung
  );
}

export function buildProgressSummary(
  accumulatedCount: number,
  perPlanCounts: Map<number, number>,
  baseLocation: string,
  currentRadiusKm: number,
): string {
  const parts: string[] = [];
  const entries = Array.from(perPlanCounts.entries());
  for (const [version, count] of entries) {
    parts.push(`${count} from plan v${version}`);
  }
  if (currentRadiusKm > 0) {
    parts.push(`searched within ${currentRadiusKm}km of ${baseLocation}`);
  } else {
    parts.push(`in ${baseLocation}`);
  }
  return `${accumulatedCount} total (${parts.join(', ')})`;
}
