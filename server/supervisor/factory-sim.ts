/**
 * FACTORY_SIM — Deterministic injection-moulding simulator tool.
 *
 * Accepts { scenario, constraints, step_index, prior_state, proposed_action, machine }
 * Returns { scrap_rate_now, defect_type, energy_kwh_per_good_part, notes, achievable_scrap_floor,
 *           available_actions, probable_cause, trend, energy_status, machine_used }
 *
 * Scenarios are preset lookup tables keyed by (machine, scenario, step_index, proposed_action).
 * Machine defaults to "primary". Alternate machine presets produce different outcomes.
 */

export interface MachineProfile {
  id: string;
  label: string;
  tool_id: string;
  tool_age_cycles: number;
  dryer_type: string;
  notes: string;
}

export const DEFAULT_MACHINES: Record<string, { primary: MachineProfile; alternate: MachineProfile }> = {
  normal: {
    primary: { id: 'M1', label: 'Machine 1 (Primary)', tool_id: 'T-4401', tool_age_cycles: 12000, dryer_type: 'standard', notes: 'Standard production machine, tooling at mid-life.' },
    alternate: { id: 'M2', label: 'Machine 2 (Alternate)', tool_id: 'T-4402', tool_age_cycles: 2000, dryer_type: 'standard', notes: 'Backup machine with newer tooling.' },
  },
  moisture_high: {
    primary: { id: 'M1', label: 'Machine 1 (Primary)', tool_id: 'T-4401', tool_age_cycles: 8000, dryer_type: 'standard', notes: 'Standard dryer, struggles with high-moisture resin.' },
    alternate: { id: 'M2', label: 'Machine 2 (Alternate)', tool_id: 'T-4403', tool_age_cycles: 5000, dryer_type: 'desiccant', notes: 'Equipped with desiccant dryer — better moisture handling.' },
  },
  tool_worn: {
    primary: { id: 'M1', label: 'Machine 1 (Primary)', tool_id: 'T-4401', tool_age_cycles: 45000, dryer_type: 'standard', notes: 'Tool at 45k of 60k cycle life, cavities 3 and 7 worn.' },
    alternate: { id: 'M2', label: 'Machine 2 (Alternate)', tool_id: 'T-4404', tool_age_cycles: 8000, dryer_type: 'standard', notes: 'Recently refurbished tool, all cavities in good condition.' },
  },
};

export interface FactorySimInput {
  scenario: string;
  constraints: { max_scrap_percent: number; max_energy_kwh?: number; [k: string]: unknown };
  step_index: number;
  prior_state: FactorySimOutput | null;
  proposed_action: string;
  machine?: 'primary' | 'alternate';
  sensor_reading?: SensorReading;
  energy_limit?: number;
}

export interface FactorySimOutput {
  scrap_rate_now: number;
  defect_type: string;
  energy_kwh_per_good_part: number;
  notes: string;
  achievable_scrap_floor: number;
  available_actions: string[];
  probable_cause: string;
  trend: 'rising' | 'stable' | 'falling';
  energy_status: 'within_limit' | 'high' | 'critical';
  machine_used: 'primary' | 'alternate';
}

interface PresetEntry {
  scrap_rate_now: number;
  defect_type: string;
  energy_kwh_per_good_part: number;
  notes: string;
  achievable_scrap_floor: number;
  available_actions: string[];
  probable_cause: string;
  trend: 'rising' | 'stable' | 'falling';
  energy_status: 'within_limit' | 'high' | 'critical';
}

type PresetKey = `${string}|${number}|${string}`;

const PRESETS: Record<PresetKey, PresetEntry> = {

  // ── Scenario: NORMAL (Primary Machine) ─────────────────────────────────
  'normal|0|baseline': {
    scrap_rate_now: 1.2,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.35,
    notes: 'Machine 1 running within normal parameters. Resin moisture low, tooling at mid-life.',
    achievable_scrap_floor: 0.5,
    available_actions: ['continue', 'increase_speed', 'reduce_speed'],
    probable_cause: 'none',
    trend: 'stable',
    energy_status: 'within_limit',
  },
  'normal|1|continue': {
    scrap_rate_now: 3.8,
    defect_type: 'flash',
    energy_kwh_per_good_part: 0.38,
    notes: 'Machine 1: Tool wear detected after 12k cycles. Flash defects appearing on parting line. Cavities 3 and 7 showing wear patterns.',
    achievable_scrap_floor: 0.8,
    available_actions: ['reduce_speed', 'increase_clamp_pressure', 'schedule_tool_refurb'],
    probable_cause: 'tool_wear',
    trend: 'rising',
    energy_status: 'within_limit',
  },
  'normal|2|reduce_speed': {
    scrap_rate_now: 1.5,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.40,
    notes: 'Machine 1: Reduced speed from 42 to 36 rpm. Flash eliminated. Scrap back within target.',
    achievable_scrap_floor: 0.8,
    available_actions: ['continue', 'schedule_tool_refurb'],
    probable_cause: 'tool_wear',
    trend: 'falling',
    energy_status: 'within_limit',
  },
  'normal|2|increase_clamp_pressure': {
    scrap_rate_now: 2.1,
    defect_type: 'sink_marks',
    energy_kwh_per_good_part: 0.42,
    notes: 'Machine 1: Higher clamp pressure reduced flash but introduced sink marks — wrong fix for tool wear. Defect type shifted, indicating mitigation mismatch.',
    achievable_scrap_floor: 0.8,
    available_actions: ['reduce_speed', 'schedule_tool_refurb'],
    probable_cause: 'tool_wear',
    trend: 'rising',
    energy_status: 'high',
  },
  'normal|2|schedule_tool_refurb': {
    scrap_rate_now: 1.0,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.36,
    notes: 'Machine 1: Tool refurbished. Running like new. Root cause (tool wear) eliminated.',
    achievable_scrap_floor: 0.5,
    available_actions: ['continue'],
    probable_cause: 'none',
    trend: 'falling',
    energy_status: 'within_limit',
  },

  // ── Scenario: MOISTURE_HIGH (Primary Machine) ──────────────────────────
  'moisture_high|0|baseline': {
    scrap_rate_now: 2.5,
    defect_type: 'splay',
    energy_kwh_per_good_part: 0.37,
    notes: 'Machine 1: Elevated resin moisture (0.18%). Standard dryer running but insufficient drying time. Splay marks visible.',
    achievable_scrap_floor: 1.5,
    available_actions: ['continue', 'dryer_boost', 'switch_resin_batch'],
    probable_cause: 'moisture_instability',
    trend: 'stable',
    energy_status: 'within_limit',
  },
  'moisture_high|1|continue': {
    scrap_rate_now: 6.2,
    defect_type: 'splay_and_bubbles',
    energy_kwh_per_good_part: 0.41,
    notes: 'Machine 1: Moisture worsened to 0.24%. Standard dryer cannot keep up. Bubbles now appearing in thick sections.',
    achievable_scrap_floor: 1.8,
    available_actions: ['dryer_boost', 'switch_resin_batch', 'reduce_speed'],
    probable_cause: 'moisture_instability',
    trend: 'rising',
    energy_status: 'within_limit',
  },
  'moisture_high|2|dryer_boost': {
    scrap_rate_now: 3.1,
    defect_type: 'splay',
    energy_kwh_per_good_part: 0.44,
    notes: 'Machine 1: Dryer boosted to 85°C for 4h. Moisture reduced but standard dryer still insufficient (0.12%). Energy rising.',
    achievable_scrap_floor: 1.5,
    available_actions: ['switch_resin_batch', 'reduce_speed'],
    probable_cause: 'moisture_instability',
    trend: 'falling',
    energy_status: 'high',
  },
  'moisture_high|2|switch_resin_batch': {
    scrap_rate_now: 2.0,
    defect_type: 'minor_splay',
    energy_kwh_per_good_part: 0.39,
    notes: 'Machine 1: Switched to dry batch B-2204 (moisture 0.04%). Significant improvement. Minor residual splay from tooling.',
    achievable_scrap_floor: 1.2,
    available_actions: ['continue', 'reduce_speed'],
    probable_cause: 'moisture_instability',
    trend: 'falling',
    energy_status: 'within_limit',
  },
  'moisture_high|2|reduce_speed': {
    scrap_rate_now: 4.5,
    defect_type: 'splay_and_flash',
    energy_kwh_per_good_part: 0.46,
    notes: 'Machine 1: Reducing speed did not help — wrong fix for moisture problem. Flash from tool wear now visible too.',
    achievable_scrap_floor: 1.8,
    available_actions: ['dryer_boost', 'switch_resin_batch'],
    probable_cause: 'moisture_instability',
    trend: 'rising',
    energy_status: 'critical',
  },

  // ── Scenario: TOOL_WORN (Primary Machine) ──────────────────────────────
  'tool_worn|0|baseline': {
    scrap_rate_now: 1.8,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.36,
    notes: 'Machine 1: Tool at 45k of 60k cycle life. Minor wear on cavity 3. Approaching maintenance window.',
    achievable_scrap_floor: 0.7,
    available_actions: ['continue', 'reduce_speed', 'increase_speed'],
    probable_cause: 'tool_wear',
    trend: 'stable',
    energy_status: 'within_limit',
  },
  'tool_worn|1|continue': {
    scrap_rate_now: 5.4,
    defect_type: 'flash_and_short_shot',
    energy_kwh_per_good_part: 0.39,
    notes: 'Machine 1: Critical wear on cavities 3 and 7. Parting line degradation causing flash. Short shots from worn gate.',
    achievable_scrap_floor: 1.0,
    available_actions: ['reduce_speed', 'increase_clamp_pressure', 'schedule_tool_refurb', 'disable_cavities'],
    probable_cause: 'tool_wear',
    trend: 'rising',
    energy_status: 'within_limit',
  },
  'tool_worn|2|reduce_speed': {
    scrap_rate_now: 3.2,
    defect_type: 'flash',
    energy_kwh_per_good_part: 0.43,
    notes: 'Machine 1: Speed reduction helped short shots but flash persists — addresses symptom, not root cause. Energy rising.',
    achievable_scrap_floor: 1.0,
    available_actions: ['schedule_tool_refurb', 'disable_cavities'],
    probable_cause: 'tool_wear',
    trend: 'falling',
    energy_status: 'high',
  },
  'tool_worn|2|increase_clamp_pressure': {
    scrap_rate_now: 2.8,
    defect_type: 'sink_marks',
    energy_kwh_per_good_part: 0.45,
    notes: 'Machine 1: Increased clamp pressure eliminated flash but introduced sink marks — wrong fix. Energy spiking.',
    achievable_scrap_floor: 1.0,
    available_actions: ['reduce_speed', 'schedule_tool_refurb', 'disable_cavities'],
    probable_cause: 'tool_wear',
    trend: 'rising',
    energy_status: 'critical',
  },
  'tool_worn|2|schedule_tool_refurb': {
    scrap_rate_now: 1.1,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.37,
    notes: 'Machine 1: Tool refurbished during planned downtime. All cavities restored.',
    achievable_scrap_floor: 0.5,
    available_actions: ['continue'],
    probable_cause: 'none',
    trend: 'falling',
    energy_status: 'within_limit',
  },
  'tool_worn|2|disable_cavities': {
    scrap_rate_now: 1.4,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.41,
    notes: 'Machine 1: Cavities 3 and 7 disabled. Output rate reduced 25% but quality restored.',
    achievable_scrap_floor: 0.7,
    available_actions: ['continue', 'schedule_tool_refurb'],
    probable_cause: 'tool_wear',
    trend: 'falling',
    energy_status: 'within_limit',
  },
};

// ── ALTERNATE MACHINE PRESETS ─────────────────────────────────────────────
// These represent outcomes when production is moved to Machine 2.
// Alternate machine has different characteristics per scenario:
//   normal: newer tooling → lower scrap after switch
//   moisture_high: desiccant dryer → much better moisture handling
//   tool_worn: fresh tool → no wear issues

const ALT_PRESETS: Record<PresetKey, PresetEntry> = {

  // ── Normal scenario on Machine 2 (newer tooling) ───────────────────────
  'normal|2|continue': {
    scrap_rate_now: 1.3,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.36,
    notes: 'Machine 2: Newer tool T-4402 (2k cycles). No flash — parting line intact. Running smoothly.',
    achievable_scrap_floor: 0.5,
    available_actions: ['continue'],
    probable_cause: 'none',
    trend: 'falling',
    energy_status: 'within_limit',
  },
  'normal|2|reduce_speed': {
    scrap_rate_now: 1.1,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.37,
    notes: 'Machine 2: Fresh tool at reduced speed. Excellent quality.',
    achievable_scrap_floor: 0.4,
    available_actions: ['continue'],
    probable_cause: 'none',
    trend: 'falling',
    energy_status: 'within_limit',
  },

  // ── Moisture_high on Machine 2 (desiccant dryer) ───────────────────────
  'moisture_high|2|continue': {
    scrap_rate_now: 1.6,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.38,
    notes: 'Machine 2: Desiccant dryer reduced moisture to 0.03%. Splay eliminated. Quality restored by addressing root cause at the machine level.',
    achievable_scrap_floor: 0.8,
    available_actions: ['continue'],
    probable_cause: 'none',
    trend: 'falling',
    energy_status: 'within_limit',
  },
  'moisture_high|2|dryer_boost': {
    scrap_rate_now: 1.4,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.40,
    notes: 'Machine 2: Desiccant dryer already effective — boost further reduced moisture to 0.02%. Excellent results.',
    achievable_scrap_floor: 0.6,
    available_actions: ['continue'],
    probable_cause: 'none',
    trend: 'falling',
    energy_status: 'within_limit',
  },
  'moisture_high|2|switch_resin_batch': {
    scrap_rate_now: 1.2,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.37,
    notes: 'Machine 2: Dry resin batch + desiccant dryer = optimal moisture control. Near-zero defects.',
    achievable_scrap_floor: 0.5,
    available_actions: ['continue'],
    probable_cause: 'none',
    trend: 'falling',
    energy_status: 'within_limit',
  },

  // ── Tool_worn on Machine 2 (fresh tool) ────────────────────────────────
  'tool_worn|2|continue': {
    scrap_rate_now: 1.2,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.35,
    notes: 'Machine 2: Fresh tool T-4404 (8k cycles). No flash, no short shots. Root cause (worn tool) eliminated by switching machines.',
    achievable_scrap_floor: 0.5,
    available_actions: ['continue'],
    probable_cause: 'none',
    trend: 'falling',
    energy_status: 'within_limit',
  },
  'tool_worn|2|reduce_speed': {
    scrap_rate_now: 1.0,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.36,
    notes: 'Machine 2: Fresh tool at reduced speed. Top quality output.',
    achievable_scrap_floor: 0.4,
    available_actions: ['continue'],
    probable_cause: 'none',
    trend: 'falling',
    energy_status: 'within_limit',
  },
  'tool_worn|2|schedule_tool_refurb': {
    scrap_rate_now: 0.9,
    defect_type: 'none',
    energy_kwh_per_good_part: 0.34,
    notes: 'Machine 2: Fresh tool + preventive refurb scheduled. Optimal condition.',
    achievable_scrap_floor: 0.3,
    available_actions: ['continue'],
    probable_cause: 'none',
    trend: 'falling',
    energy_status: 'within_limit',
  },
};

export interface SensorReading {
  scrap_rate_now: number;
  defect_type: string;
  energy_kwh_per_good_part: number;
  achievable_scrap_floor?: number;
  probable_cause?: string;
  notes?: string;
  energy_status?: 'within_limit' | 'high' | 'critical';
  trend?: 'rising' | 'stable' | 'falling';
  available_actions?: string[];
}

export interface DemoSensorScript {
  primary?: Record<number, SensorReading>;
  alternate?: Record<number, SensorReading>;
}

function inferCauseFromDefect(defect: string): string {
  if (!defect || defect === 'none') return 'none';
  if (defect.includes('splay') || defect.includes('bubble')) return 'moisture_instability';
  if (defect.includes('flash') || defect.includes('short_shot') || defect.includes('sink')) return 'tool_wear';
  return 'unknown';
}

function inferTrend(currentScrap: number, priorState: FactorySimOutput | null): 'rising' | 'stable' | 'falling' {
  if (!priorState) return 'stable';
  const delta = currentScrap - priorState.scrap_rate_now;
  if (delta > 0.3) return 'rising';
  if (delta < -0.3) return 'falling';
  return 'stable';
}

function inferEnergyStatus(energy: number, energyLimit?: number): 'within_limit' | 'high' | 'critical' {
  const limit = energyLimit ?? 0.44;
  if (energy > limit * 1.1) return 'critical';
  if (energy > limit) return 'high';
  return 'within_limit';
}

function applySensorOverride(
  baseOutput: FactorySimOutput,
  sensor: SensorReading,
  priorState: FactorySimOutput | null,
  energyLimit?: number,
): FactorySimOutput {
  const scrap = sensor.scrap_rate_now;
  const defect = sensor.defect_type;
  const energy = sensor.energy_kwh_per_good_part;

  return {
    scrap_rate_now: scrap,
    defect_type: defect,
    energy_kwh_per_good_part: energy,
    achievable_scrap_floor: sensor.achievable_scrap_floor ?? Math.min(scrap, baseOutput.achievable_scrap_floor),
    probable_cause: sensor.probable_cause ?? inferCauseFromDefect(defect),
    trend: sensor.trend ?? inferTrend(scrap, priorState),
    energy_status: sensor.energy_status ?? inferEnergyStatus(energy, energyLimit),
    notes: sensor.notes ?? `Sensor override: scrap=${scrap}% defect=${defect} energy=${energy}kWh.`,
    available_actions: sensor.available_actions ?? baseOutput.available_actions,
    machine_used: baseOutput.machine_used,
  };
}

export const ENERGY_THRESHOLDS: Record<string, number> = {
  off_peak: 0.50,
  standard: 0.44,
  peak: 0.40,
};

export function getEnergyLimit(energyPriceBand?: string): number {
  return ENERGY_THRESHOLDS[energyPriceBand ?? 'standard'] ?? 0.44;
}

export function runFactorySim(input: FactorySimInput): FactorySimOutput {
  const machine = input.machine ?? 'primary';
  const key: PresetKey = `${input.scenario}|${input.step_index}|${input.proposed_action}`;

  let baseOutput: FactorySimOutput;

  if (machine === 'alternate') {
    const altPreset = ALT_PRESETS[key];
    if (altPreset) {
      baseOutput = { ...altPreset, machine_used: 'alternate' };
    } else {
      const preset = PRESETS[key];
      baseOutput = preset
        ? { ...preset, machine_used: machine }
        : {
            scrap_rate_now: input.prior_state?.scrap_rate_now ?? 2.0,
            defect_type: 'unknown',
            energy_kwh_per_good_part: 0.40,
            notes: `No preset for key="${key}" machine="${machine}". Returning fallback state.`,
            achievable_scrap_floor: input.prior_state?.achievable_scrap_floor ?? 1.0,
            available_actions: ['continue', 'reduce_speed'],
            probable_cause: 'unknown',
            trend: 'stable',
            energy_status: 'within_limit',
            machine_used: machine,
          };
    }
  } else {
    const preset = PRESETS[key];
    baseOutput = preset
      ? { ...preset, machine_used: machine }
      : {
          scrap_rate_now: input.prior_state?.scrap_rate_now ?? 2.0,
          defect_type: 'unknown',
          energy_kwh_per_good_part: 0.40,
          notes: `No preset for key="${key}" machine="${machine}". Returning fallback state.`,
          achievable_scrap_floor: input.prior_state?.achievable_scrap_floor ?? 1.0,
          available_actions: ['continue', 'reduce_speed'],
          probable_cause: 'unknown',
          trend: 'stable',
          energy_status: 'within_limit',
          machine_used: machine,
        };
  }

  if (input.sensor_reading) {
    return applySensorOverride(baseOutput, input.sensor_reading, input.prior_state, input.energy_limit);
  }

  return baseOutput;
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

export const CAUSE_BASED_INTERVENTIONS: Record<string, { options: string[]; rationale: Record<string, string> }> = {
  moisture_instability: {
    options: ['dryer_boost', 'switch_resin_batch'],
    rationale: {
      dryer_boost: 'Increase drying temperature/time to reduce resin moisture content',
      switch_resin_batch: 'Replace the wet resin with a pre-dried batch to eliminate the moisture source',
    },
  },
  tool_wear: {
    options: ['reduce_speed', 'increase_clamp_pressure', 'schedule_tool_refurb', 'disable_cavities'],
    rationale: {
      reduce_speed: 'Slow injection to reduce stress on worn cavities',
      increase_clamp_pressure: 'Increase clamp force to compensate for worn parting line',
      schedule_tool_refurb: 'Refurbish the tool to eliminate the root cause of wear',
      disable_cavities: 'Take worn cavities offline to restore quality at reduced output',
    },
  },
  none: {
    options: ['continue'],
    rationale: { continue: 'No intervention needed — conditions are normal' },
  },
  unknown: {
    options: ['reduce_speed', 'continue'],
    rationale: {
      reduce_speed: 'Conservative approach to reduce defect risk',
      continue: 'Continue monitoring for further diagnosis',
    },
  },
};

export const ALTERNATIVE_MITIGATIONS: Record<DemoScenario, string[]> = {
  normal: ['increase_clamp_pressure', 'schedule_tool_refurb'],
  moisture_high: ['switch_resin_batch', 'reduce_speed'],
  tool_worn: ['schedule_tool_refurb', 'disable_cavities'],
};
