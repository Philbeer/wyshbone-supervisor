/**
 * FACTORY_SIM — Deterministic injection-moulding simulator tool.
 *
 * Accepts { scenario, constraints, step_index, prior_state, proposed_action }
 * Returns { scrap_rate_now, defect_type, energy_kwh_per_good_part, notes, achievable_scrap_floor, available_actions }
 *
 * Scenarios are preset lookup tables keyed by (scenario, step_index, proposed_action).
 */

export interface FactorySimInput {
  scenario: string;
  constraints: { max_scrap_percent: number; [k: string]: unknown };
  step_index: number;
  prior_state: FactorySimOutput | null;
  proposed_action: string;
}

export interface FactorySimOutput {
  scrap_rate_now: number;
  defect_type: string;
  energy_kwh_per_good_part: number;
  notes: string;
  achievable_scrap_floor: number;
  available_actions: string[];
}

interface PresetEntry {
  scrap_rate_now: number;
  defect_type: string;
  energy_kwh_per_good_part: number;
  notes: string;
  achievable_scrap_floor: number;
  available_actions: string[];
}

type PresetKey = `${string}|${number}|${string}`;

const PRESETS: Record<PresetKey, PresetEntry> = {

  // ── Scenario: NORMAL ───────────────────────────────────────────────────
  'normal|0|baseline': {
    scrap_rate_now: 1.2,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.35,
    notes: 'Machine running within normal parameters. Resin moisture low, tooling new.',
    achievable_scrap_floor: 0.5,
    available_actions: ['continue', 'increase_speed', 'reduce_speed'],
  },
  'normal|1|continue': {
    scrap_rate_now: 3.8,
    defect_type: 'flash',
    energy_kwh_per_good_part: 0.38,
    notes: 'Tool wear detected after 12k cycles. Flash defects appearing on parting line.',
    achievable_scrap_floor: 0.8,
    available_actions: ['reduce_speed', 'increase_clamp_pressure', 'schedule_tool_refurb'],
  },
  'normal|2|reduce_speed': {
    scrap_rate_now: 1.5,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.40,
    notes: 'Reduced speed from 42 to 36 rpm. Flash eliminated. Scrap back within target.',
    achievable_scrap_floor: 0.8,
    available_actions: ['continue', 'schedule_tool_refurb'],
  },
  'normal|2|increase_clamp_pressure': {
    scrap_rate_now: 2.1,
    defect_type: 'sink_marks',
    energy_kwh_per_good_part: 0.42,
    notes: 'Higher clamp pressure reduced flash but introduced sink marks. Marginal improvement.',
    achievable_scrap_floor: 0.8,
    available_actions: ['reduce_speed', 'schedule_tool_refurb'],
  },
  'normal|2|schedule_tool_refurb': {
    scrap_rate_now: 1.0,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.36,
    notes: 'Tool refurbished. Running like new. Best achievable outcome.',
    achievable_scrap_floor: 0.5,
    available_actions: ['continue'],
  },

  // ── Scenario: MOISTURE_HIGH ────────────────────────────────────────────
  // This scenario has achievable_scrap_floor > 1% so Tower can STOP
  // for constraints.max_scrap_percent <= 1.
  'moisture_high|0|baseline': {
    scrap_rate_now: 2.5,
    defect_type: 'splay',
    energy_kwh_per_good_part: 0.37,
    notes: 'Elevated resin moisture (0.18%). Splay marks visible on surface.',
    achievable_scrap_floor: 1.5,
    available_actions: ['continue', 'dryer_boost', 'switch_resin_batch'],
  },
  'moisture_high|1|continue': {
    scrap_rate_now: 6.2,
    defect_type: 'splay_and_bubbles',
    energy_kwh_per_good_part: 0.41,
    notes: 'Moisture worsened. Bubbles now appearing in thick sections. Tool also showing wear.',
    achievable_scrap_floor: 1.8,
    available_actions: ['dryer_boost', 'switch_resin_batch', 'reduce_speed'],
  },
  'moisture_high|2|dryer_boost': {
    scrap_rate_now: 3.1,
    defect_type: 'splay',
    energy_kwh_per_good_part: 0.44,
    notes: 'Dryer boosted to 85°C for 4h. Moisture reduced but still above spec. Splay persists.',
    achievable_scrap_floor: 1.5,
    available_actions: ['switch_resin_batch', 'reduce_speed'],
  },
  'moisture_high|2|switch_resin_batch': {
    scrap_rate_now: 2.0,
    defect_type: 'minor_splay',
    energy_kwh_per_good_part: 0.39,
    notes: 'Switched to dry batch B-2204. Significant improvement but floor remains above 1%.',
    achievable_scrap_floor: 1.2,
    available_actions: ['continue', 'reduce_speed'],
  },
  'moisture_high|2|reduce_speed': {
    scrap_rate_now: 4.5,
    defect_type: 'splay_and_flash',
    energy_kwh_per_good_part: 0.46,
    notes: 'Reducing speed did not help with moisture-related defects. Flash from tool wear now visible too.',
    achievable_scrap_floor: 1.8,
    available_actions: ['dryer_boost', 'switch_resin_batch'],
  },

  // ── Scenario: TOOL_WORN ────────────────────────────────────────────────
  'tool_worn|0|baseline': {
    scrap_rate_now: 1.8,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.36,
    notes: 'Tool at 45k of 60k cycle life. Minor wear on cavity 3.',
    achievable_scrap_floor: 0.7,
    available_actions: ['continue', 'reduce_speed', 'increase_speed'],
  },
  'tool_worn|1|continue': {
    scrap_rate_now: 5.4,
    defect_type: 'flash_and_short_shot',
    energy_kwh_per_good_part: 0.39,
    notes: 'Critical wear on cavities 3 and 7. Flash and short shots. Immediate action needed.',
    achievable_scrap_floor: 1.0,
    available_actions: ['reduce_speed', 'schedule_tool_refurb', 'disable_cavities'],
  },
  'tool_worn|2|reduce_speed': {
    scrap_rate_now: 3.2,
    defect_type: 'flash',
    energy_kwh_per_good_part: 0.43,
    notes: 'Speed reduction helped short shots but flash persists. Partial fix only.',
    achievable_scrap_floor: 1.0,
    available_actions: ['schedule_tool_refurb', 'disable_cavities'],
  },
  'tool_worn|2|schedule_tool_refurb': {
    scrap_rate_now: 1.1,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.37,
    notes: 'Tool refurbished during planned downtime. All cavities restored.',
    achievable_scrap_floor: 0.5,
    available_actions: ['continue'],
  },
  'tool_worn|2|disable_cavities': {
    scrap_rate_now: 1.4,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.41,
    notes: 'Cavities 3 and 7 disabled. Output rate reduced 25% but quality restored.',
    achievable_scrap_floor: 0.7,
    available_actions: ['continue', 'schedule_tool_refurb'],
  },
};

export function runFactorySim(input: FactorySimInput): FactorySimOutput {
  const key: PresetKey = `${input.scenario}|${input.step_index}|${input.proposed_action}`;
  const preset = PRESETS[key];

  if (preset) {
    return { ...preset };
  }

  return {
    scrap_rate_now: input.prior_state?.scrap_rate_now ?? 2.0,
    defect_type: 'unknown',
    energy_kwh_per_good_part: 0.40,
    notes: `No preset for key="${key}". Returning fallback state.`,
    achievable_scrap_floor: input.prior_state?.achievable_scrap_floor ?? 1.0,
    available_actions: ['continue', 'reduce_speed'],
  };
}

export const DEMO_SCENARIOS = ['normal', 'moisture_high', 'tool_worn'] as const;
export type DemoScenario = typeof DEMO_SCENARIOS[number];

export interface FactoryDemoStep {
  step_index: number;
  label: string;
  proposed_action: string;
}

export function buildDemoSteps(scenario: DemoScenario): FactoryDemoStep[] {
  return [
    { step_index: 0, label: 'Baseline assessment', proposed_action: 'baseline' },
    { step_index: 1, label: 'Production drift detection', proposed_action: 'continue' },
    { step_index: 2, label: 'Mitigation response', proposed_action: getDefaultMitigation(scenario) },
  ];
}

function getDefaultMitigation(scenario: DemoScenario): string {
  switch (scenario) {
    case 'normal': return 'reduce_speed';
    case 'moisture_high': return 'dryer_boost';
    case 'tool_worn': return 'reduce_speed';
  }
}

export const ALTERNATIVE_MITIGATIONS: Record<DemoScenario, string[]> = {
  normal: ['increase_clamp_pressure', 'schedule_tool_refurb'],
  moisture_high: ['switch_resin_batch', 'reduce_speed'],
  tool_worn: ['schedule_tool_refurb', 'disable_cavities'],
};
