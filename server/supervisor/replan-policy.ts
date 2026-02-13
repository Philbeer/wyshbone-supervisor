import type { ArtefactJudgementResponse } from './tower-artefact-judge';

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
  country: string;
  search_count: number;
  requested_count: number;
  prefix_filter: string | undefined;
}

export interface PlanV2Result {
  constraints: PlanV2Constraints;
  adjustments_applied: Array<{ field: string; action: string; from: unknown; to: unknown; reason: string }>;
  strategy_summary: string;
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
  if (f === 'radius') return 'search_count';
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
      field: 'search_count',
      action: 'increase',
      reason: 'Default fallback: increase search volume',
    });
  }

  return changes;
}

export function applyLeadgenReplanPolicy(
  currentConstraints: PlanV2Constraints,
  directive: TowerChangePlanDirective,
): PlanV2Result {
  const next = { ...currentConstraints };
  const adjustments: PlanV2Result['adjustments_applied'] = [];

  for (const change of directive.suggested_changes) {
    switch (change.field) {
      case 'prefix_filter':
        if ((change.action === 'drop' || change.action === 'relax') && next.prefix_filter) {
          adjustments.push({
            field: 'prefix_filter',
            action: 'drop',
            from: next.prefix_filter,
            to: undefined,
            reason: change.reason,
          });
          next.prefix_filter = undefined;
        }
        break;

      case 'location':
        if (change.action === 'expand') {
          const expanded = next.location.includes('within')
            ? next.location.replace(/within \d+km/, 'within 25km')
            : `${next.location} within 10km`;
          adjustments.push({
            field: 'location',
            action: 'expand',
            from: next.location,
            to: expanded,
            reason: change.reason,
          });
          next.location = expanded;
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
          }
        }
        break;

      case 'business_type':
        if (change.action === 'broaden' && change.suggested_value) {
          adjustments.push({
            field: 'business_type',
            action: 'broaden',
            from: next.business_type,
            to: change.suggested_value,
            reason: change.reason,
          });
          next.business_type = String(change.suggested_value);
        }
        break;
    }
  }

  const strategies = adjustments.map(a => `${a.action} ${a.field}`);
  const strategy_summary = strategies.length > 0
    ? `Plan v2: ${strategies.join(', ')}`
    : 'Plan v2: no changes applied (fallback)';

  return {
    constraints: next,
    adjustments_applied: adjustments,
    strategy_summary,
  };
}
