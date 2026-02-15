/**
 * Factory Demo Runner — Executes a fixed 3-step injection-moulding demo plan.
 *
 * Step 1: Baseline assessment (on primary machine)
 * Step 2: Production drift (scrap rises on primary machine)
 * Step 3: Mitigation response (on current machine, or alternate if switched)
 *
 * Each step writes:
 *   - factory_state artefact (includes machine_used, machine profile)
 *   - factory_decision artefact (states machine choice + reason)
 *
 * Tower judgement triggers:
 *   - CHANGE_PLAN → switch to alternate machine + optionally change mitigation
 *   - STOP → terminate (floor above target / energy critical)
 *   - continue → proceed on current machine
 *
 * Machine switching:
 *   On CHANGE_PLAN, production moves from primary (Machine 1) to alternate (Machine 2).
 *   The alternate machine has different characteristics (e.g. better dryer, newer tool).
 *   Factory conditions (scenario, moisture, temp) remain the same — only the machine changes.
 */

import { randomUUID } from 'crypto';
import {
  runFactorySim,
  buildDemoSteps,
  ALTERNATIVE_MITIGATIONS,
  CAUSE_BASED_INTERVENTIONS,
  DEFAULT_MACHINES,
  getEnergyLimit,
  type MachineProfile,
  type FactorySimInput,
  type FactorySimOutput,
  type DemoScenario,
} from './factory-sim';
import { createArtefact } from './artefacts';
import { logAFREvent } from './afr-logger';
import { storage } from '../storage';
import { generateRunNarrative } from './run-narrative';

interface FactoryTowerVerdict {
  verdict: string;
  action: 'continue' | 'change_plan' | 'stop';
  reasons: string[];
  metrics: Record<string, unknown>;
  trigger: string;
}

interface StepHistory {
  stepIndex: number;
  scrap: number;
  defect: string;
  trend: string;
  cause: string;
  energy: number;
  energyStatus: string;
  machineUsed: string;
}

function judgeFactoryStep(
  stepIndex: number,
  simOutput: FactorySimOutput,
  maxScrapPercent: number,
  scenario: DemoScenario,
  history: StepHistory[],
  energyLimit: number,
): FactoryTowerVerdict {
  const scrap = simOutput.scrap_rate_now;
  const floor = simOutput.achievable_scrap_floor;
  const energy = simOutput.energy_kwh_per_good_part;
  const cause = simOutput.probable_cause;
  const trend = simOutput.trend;
  const defect = simOutput.defect_type;
  const machineUsed = simOutput.machine_used;
  const aboveTarget = scrap > maxScrapPercent;
  const floorAboveTarget = floor > maxScrapPercent;

  const metrics: Record<string, unknown> = {
    scrap_rate: scrap, target: maxScrapPercent, floor, step: stepIndex,
    defect, cause, trend, energy, energy_limit: energyLimit,
    machine_used: machineUsed,
  };

  if (stepIndex === 0) {
    if (aboveTarget && floorAboveTarget) {
      return {
        verdict: 'fail', action: 'stop',
        reasons: [
          `Baseline scrap ${scrap}% on ${machineUsed} machine already above target ${maxScrapPercent}%.`,
          `Diagnosed cause: ${formatCause(cause)}. Achievable floor ${floor}% is also above target — impossible to meet constraint.`,
        ],
        metrics, trigger: 'floor_above_target',
      };
    }
    if (energy > energyLimit) {
      return {
        verdict: 'warn', action: 'continue',
        reasons: [
          `Baseline scrap ${scrap}% acceptable on ${machineUsed} machine, but energy ${energy} kWh/part exceeds limit ${energyLimit} kWh.`,
          `Diagnosed cause: ${formatCause(cause)}. Trend: ${trend}.`,
        ],
        metrics, trigger: 'energy_warning_baseline',
      };
    }
    return {
      verdict: 'pass', action: 'continue',
      reasons: [
        `Baseline scrap ${scrap}% acceptable on ${machineUsed} machine. Diagnosed cause: ${formatCause(cause)}.`,
        `Trend: ${trend}. Energy: ${energy} kWh/part (within limit). Proceeding to monitor for drift.`,
      ],
      metrics, trigger: 'baseline_ok',
    };
  }

  const trendRising2Steps = history.length >= 1 && history[history.length - 1].trend === 'rising' && trend === 'rising';

  const prevDefect = history.length > 0 ? history[history.length - 1].defect : null;
  const defectShifted = prevDefect !== null && prevDefect !== 'none' && defect !== 'none' && defect !== prevDefect;

  const energyExceeded = energy > energyLimit;
  const energyCritical = simOutput.energy_status === 'critical';

  if (floorAboveTarget && aboveTarget) {
    return {
      verdict: 'fail', action: 'stop',
      reasons: [
        `Scrap ${scrap}% on ${machineUsed} machine above target ${maxScrapPercent}%. Floor ${floor}% makes target unachievable.`,
        `Root cause: ${formatCause(cause)}. Trend: ${trend}.`,
        ...(energyCritical ? [`Energy ${energy} kWh/part is critical — no viable path forward.`] : []),
      ],
      metrics, trigger: 'floor_above_target',
    };
  }

  if (energyCritical && aboveTarget) {
    return {
      verdict: 'fail', action: 'stop',
      reasons: [
        `Energy ${energy} kWh/part is critical (limit ${energyLimit}) on ${machineUsed} machine. Scrap ${scrap}% above target.`,
        `Root cause: ${formatCause(cause)}. Current approach is consuming too much energy with no path to recovery.`,
      ],
      metrics, trigger: 'energy_critical_stop',
    };
  }

  if (defectShifted && stepIndex >= 2) {
    return {
      verdict: 'warn', action: 'change_plan',
      reasons: [
        `Defect type shifted from "${prevDefect}" to "${defect}" on ${machineUsed} machine after mitigation — mitigation mismatch.`,
        `Root cause (${formatCause(cause)}) was not addressed. Consider switching to alternate machine.`,
      ],
      metrics: { ...metrics, previous_defect: prevDefect, defect_shift: true },
      trigger: 'defect_shift_mismatch',
    };
  }

  if (trendRising2Steps && !aboveTarget) {
    return {
      verdict: 'warn', action: 'change_plan',
      reasons: [
        `Scrap trend rising for 2 consecutive steps on ${machineUsed} machine (${history[history.length - 1].scrap}% → ${scrap}%), still under target but deteriorating.`,
        `Root cause: ${formatCause(cause)}. Preemptive switch to alternate machine recommended.`,
      ],
      metrics, trigger: 'trend_rising_preemptive',
    };
  }

  if (aboveTarget) {
    return {
      verdict: 'warn', action: 'change_plan',
      reasons: [
        `Scrap ${scrap}% on ${machineUsed} machine exceeds target ${maxScrapPercent}%. Floor ${floor}% suggests recovery is possible.`,
        `Root cause: ${formatCause(cause)}. Trend: ${trend}. Switching to alternate machine for better handling of ${formatCause(cause)}.`,
        ...(energyExceeded ? [`Energy ${energy} kWh/part exceeds limit ${energyLimit}.`] : []),
      ],
      metrics, trigger: 'scrap_above_target',
    };
  }

  if (energyExceeded && stepIndex >= 2) {
    return {
      verdict: 'warn', action: 'change_plan',
      reasons: [
        `Scrap ${scrap}% within target on ${machineUsed} machine, but energy ${energy} kWh/part exceeds limit ${energyLimit}.`,
        `Alternate machine may achieve same quality with lower energy consumption.`,
      ],
      metrics, trigger: 'energy_exceeded',
    };
  }

  return {
    verdict: 'pass', action: 'continue',
    reasons: [
      `Scrap ${scrap}% within target ${maxScrapPercent}% on ${machineUsed} machine. Energy ${energy} kWh/part within limit.`,
      `Root cause: ${formatCause(cause)}. Trend: ${trend}. No intervention required.`,
    ],
    metrics, trigger: 'all_ok',
  };
}

function formatCause(cause: string): string {
  const labels: Record<string, string> = {
    moisture_instability: 'moisture instability (resin too wet)',
    tool_wear: 'tool wear (cavity degradation)',
    temp_swing: 'temperature swing',
    none: 'no issues detected',
    unknown: 'undetermined',
  };
  return labels[cause] ?? cause;
}

function selectIntervention(
  cause: string,
  previousMitigation: string | null,
  scenario: DemoScenario,
  defectShifted: boolean,
): { intervention: string; rationale: string; considered: string[] } {
  const causeEntry = CAUSE_BASED_INTERVENTIONS[cause] ?? CAUSE_BASED_INTERVENTIONS['unknown'];
  const considered = causeEntry.options;

  let selected: string;

  if (defectShifted && previousMitigation) {
    selected = considered.find(o => o !== previousMitigation) ?? considered[0];
  } else if (previousMitigation) {
    selected = considered.find(o => o !== previousMitigation) ?? considered[0];
  } else {
    selected = considered[0];
  }

  const alternatives = ALTERNATIVE_MITIGATIONS[scenario] || [];
  if (!considered.includes(selected) && alternatives.length > 0) {
    selected = alternatives.find(a => a !== previousMitigation) ?? alternatives[0];
  }

  const rationale = causeEntry.rationale[selected] ?? `Selected ${selected} based on ${cause} diagnosis`;

  return { intervention: selected, rationale, considered };
}

export interface FactoryDemoParams {
  runId: string;
  userId: string;
  conversationId?: string;
  clientRequestId?: string;
  scenario?: DemoScenario;
  maxScrapPercent?: number;
  energyPriceBand?: string;
  machines?: { primary: MachineProfile; alternate: MachineProfile };
}

export interface FactoryDemoResult {
  success: boolean;
  stepsCompleted: number;
  finalState: FactorySimOutput | null;
  stoppedByTower: boolean;
  planChanged: boolean;
  machineSwitched: boolean;
  finalMachine: string;
  summary: string;
}

export async function executeFactoryDemo(params: FactoryDemoParams): Promise<FactoryDemoResult> {
  const {
    runId,
    userId,
    conversationId,
    clientRequestId,
    scenario = 'moisture_high',
    maxScrapPercent = 2.0,
    energyPriceBand = 'standard',
  } = params;

  const scenarioMachines = DEFAULT_MACHINES[scenario] ?? DEFAULT_MACHINES['moisture_high'];
  const machines = params.machines ?? scenarioMachines;

  const logPrefix = `[FACTORY_DEMO]`;
  const energyLimit = getEnergyLimit(energyPriceBand);
  console.log(`${logPrefix} Starting demo — scenario=${scenario} max_scrap=${maxScrapPercent}% energy_limit=${energyLimit}kWh primary=${machines.primary.id} alternate=${machines.alternate.id} runId=${runId}`);

  const constraints = { max_scrap_percent: maxScrapPercent, max_energy_kwh: energyLimit };
  const steps = buildDemoSteps(scenario);

  await logAFREvent({
    userId, runId, conversationId, clientRequestId,
    actionTaken: 'factory_demo_started', status: 'pending',
    taskGenerated: `Factory demo: ${scenario}, max scrap ${maxScrapPercent}%, primary=${machines.primary.id}, alternate=${machines.alternate.id}`,
    runType: 'plan',
    metadata: { scenario, maxScrapPercent, energyPriceBand, energyLimit, stepCount: steps.length, machines },
  }).catch(() => {});

  const planArtefact = await createArtefact({
    runId, userId, conversationId,
    type: 'plan',
    title: `Factory Demo Plan: ${scenario}`,
    summary: `3-step injection moulding simulation (${scenario}), max scrap ${maxScrapPercent}%, starting on ${machines.primary.label}`,
    payload: {
      scenario,
      constraints,
      steps: steps.map(s => ({ step: s.step_index + 1, label: s.label, action: s.proposed_action })),
      plan_version: 1,
      energy_price_band: energyPriceBand,
      machines: {
        primary: machines.primary,
        alternate: machines.alternate,
      },
    },
  });

  let priorState: FactorySimOutput | null = null;
  let baselineScrap: number | null = null;
  let stepsCompleted = 0;
  let stoppedByTower = false;
  let planChanged = false;
  let machineSwitched = false;
  let currentMachine: 'primary' | 'alternate' = 'primary';
  let currentMitigation = steps[2].proposed_action;
  let mitigationAttempts = 0;
  const MAX_MITIGATION_SWITCHES = 2;
  const stepHistory: StepHistory[] = [];
  let changePlanTrigger: string | null = null;

  function currentMachineProfile(): MachineProfile {
    return currentMachine === 'primary' ? machines.primary : machines.alternate;
  }

  function machineLabel(): string {
    return currentMachineProfile().label;
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const action = i === 2 ? currentMitigation : step.proposed_action;
    const mp = currentMachineProfile();

    console.log(`${logPrefix} Step ${i + 1}/${steps.length}: ${step.label} (action=${action}, machine=${mp.label})`);

    const simInput: FactorySimInput = {
      scenario,
      constraints,
      step_index: step.step_index,
      prior_state: priorState,
      proposed_action: action,
      machine: currentMachine,
    };

    const simOutput = runFactorySim(simInput);
    const previousState = priorState;
    priorState = simOutput;

    if (i === 0) {
      baselineScrap = simOutput.scrap_rate_now;
    }

    const driftDetected = baselineScrap !== null && simOutput.scrap_rate_now > baselineScrap;
    let driftReason = 'No drift detected';
    if (driftDetected) {
      const delta = +(simOutput.scrap_rate_now - baselineScrap!).toFixed(2);
      driftReason = `Scrap increased by ${delta}pp from baseline ${baselineScrap}% to ${simOutput.scrap_rate_now}% on ${machineLabel()}. Probable cause: ${formatCause(simOutput.probable_cause)}. Defect: ${simOutput.defect_type}.`;
    } else if (i > 0) {
      driftReason = `Scrap ${simOutput.scrap_rate_now}% on ${machineLabel()} is at or below baseline ${baselineScrap}%. No adverse drift.`;
    }

    const stateArtefact = await createArtefact({
      runId, userId, conversationId,
      type: 'factory_state',
      title: `Factory State: Step ${i + 1} — ${step.label}`,
      summary: `${machineLabel()}: scrap=${simOutput.scrap_rate_now}% defect=${simOutput.defect_type} cause=${simOutput.probable_cause} trend=${simOutput.trend} energy=${simOutput.energy_kwh_per_good_part}kWh(${simOutput.energy_status})`,
      payload: {
        ...simOutput,
        step_index: step.step_index,
        scenario,
        action_taken: action,
        baseline_scrap_percent: baselineScrap ?? simOutput.scrap_rate_now,
        achievable_scrap_floor_percent: simOutput.achievable_scrap_floor,
        drift_detected: driftDetected,
        drift_reason: driftReason,
        energy_per_part: simOutput.energy_kwh_per_good_part,
        energy_limit: energyLimit,
        machine_used: currentMachine,
        machine_id: mp.id,
        machine_label: mp.label,
        tool_id: mp.tool_id,
        diagnosis: {
          probable_cause: simOutput.probable_cause,
          trend: simOutput.trend,
          energy_status: simOutput.energy_status,
        },
      },
    });

    const isAboveTarget = simOutput.scrap_rate_now > constraints.max_scrap_percent;
    const isFloorAboveTarget = simOutput.achievable_scrap_floor > constraints.max_scrap_percent;
    const prevDefect = previousState?.defect_type ?? null;
    const defectShifted = prevDefect !== null && prevDefect !== 'none' && simOutput.defect_type !== 'none' && simOutput.defect_type !== prevDefect;

    let decision: string;
    let reason: string;
    let expectedImpact: string;
    let interventionRationale: string | null = null;
    let interventionConsidered: string[] | null = null;

    if (i === 0) {
      decision = 'proceed_to_monitoring';
      reason = `Baseline on ${machineLabel()} complete. Scrap ${simOutput.scrap_rate_now}%, floor=${simOutput.achievable_scrap_floor}%. Diagnosis: ${formatCause(simOutput.probable_cause)}, trend ${simOutput.trend}.`;
      expectedImpact = 'Monitoring for drift in next cycle batch.';
    } else if (i === 1) {
      if (isAboveTarget) {
        const selection = selectIntervention(simOutput.probable_cause, null, scenario, false);
        currentMitigation = selection.intervention;
        decision = 'intervene';
        reason = `Scrap ${simOutput.scrap_rate_now}% on ${machineLabel()} exceeds target ${constraints.max_scrap_percent}%. Diagnosed cause: ${formatCause(simOutput.probable_cause)} (trend: ${simOutput.trend}). Defect: ${simOutput.defect_type}.`;
        expectedImpact = `Selected "${selection.intervention}" — ${selection.rationale}. Considered: ${selection.considered.join(', ')}.`;
        interventionRationale = selection.rationale;
        interventionConsidered = selection.considered;
      } else {
        decision = 'continue_monitoring';
        reason = `Scrap ${simOutput.scrap_rate_now}% on ${machineLabel()} still within target. Diagnosis: ${formatCause(simOutput.probable_cause)}, trend ${simOutput.trend}.`;
        expectedImpact = 'No intervention needed at this time.';
      }
    } else {
      const improved = simOutput.scrap_rate_now < (previousState?.scrap_rate_now ?? simOutput.scrap_rate_now);
      if (defectShifted) {
        decision = 'mitigation_mismatch';
        reason = `After "${action}" on ${machineLabel()}, defect type shifted from "${prevDefect}" to "${simOutput.defect_type}" — mitigation mismatch for ${formatCause(simOutput.probable_cause)}.`;
        expectedImpact = isFloorAboveTarget
          ? `Floor ${simOutput.achievable_scrap_floor}% > target — recovery unlikely.`
          : `Switching to ${machines.alternate.label} may resolve this.`;
      } else if (isAboveTarget) {
        decision = 'escalate';
        reason = `After "${action}" on ${machineLabel()}, scrap=${simOutput.scrap_rate_now}% still above target. Cause: ${formatCause(simOutput.probable_cause)}, trend: ${simOutput.trend}.`;
        expectedImpact = isFloorAboveTarget
          ? `Floor ${simOutput.achievable_scrap_floor}% > target ${constraints.max_scrap_percent}% — target UNACHIEVABLE on this machine.`
          : `Switching to ${machines.alternate.label} may help.`;
      } else {
        const onAlternate = currentMachine === 'alternate';
        decision = 'accept';
        reason = onAlternate
          ? `Switched to ${machineLabel()}. Scrap=${simOutput.scrap_rate_now}% within target. Root cause (${formatCause(simOutput.probable_cause)}) ${improved ? 'resolved by machine switch' : 'managed'}.`
          : `Mitigation "${action}" on ${machineLabel()} succeeded. Scrap=${simOutput.scrap_rate_now}% within target. Root cause (${formatCause(simOutput.probable_cause)}) ${improved ? 'addressed' : 'managed'}.`;
        expectedImpact = 'Production can continue normally.';
      }
    }

    const decisionArtefact = await createArtefact({
      runId, userId, conversationId,
      type: 'factory_decision',
      title: `Factory Decision: Step ${i + 1} — ${decision}`,
      summary: reason,
      payload: {
        step_index: step.step_index,
        decision,
        reason,
        expected_impact: expectedImpact,
        action_taken: action,
        scrap_rate: simOutput.scrap_rate_now,
        target_scrap: constraints.max_scrap_percent,
        achievable_floor: simOutput.achievable_scrap_floor,
        floor_above_target: isFloorAboveTarget,
        machine_used: currentMachine,
        machine_label: machineLabel(),
        machine_id: mp.id,
        stayed_or_switched: machineSwitched && currentMachine === 'alternate' ? `Switched to ${machineLabel()}` : `Stayed on ${machineLabel()}`,
        diagnosis: {
          probable_cause: simOutput.probable_cause,
          trend: simOutput.trend,
          energy_status: simOutput.energy_status,
          defect_shifted: defectShifted,
          previous_defect: prevDefect,
        },
        ...(interventionRationale ? { intervention_rationale: interventionRationale } : {}),
        ...(interventionConsidered ? { intervention_considered: interventionConsidered } : {}),
      },
    });

    console.log(`${logPrefix} Step ${i + 1} artefacts: state=${stateArtefact.id} decision=${decisionArtefact.id} machine=${mp.label}`);

    const towerVerdict = judgeFactoryStep(step.step_index, simOutput, constraints.max_scrap_percent, scenario, stepHistory, energyLimit);
    const verdict = towerVerdict.verdict;
    const towerAction = towerVerdict.action;

    stepHistory.push({
      stepIndex: step.step_index,
      scrap: simOutput.scrap_rate_now,
      defect: simOutput.defect_type,
      trend: simOutput.trend,
      cause: simOutput.probable_cause,
      energy: simOutput.energy_kwh_per_good_part,
      energyStatus: simOutput.energy_status,
      machineUsed: currentMachine,
    });

    const judgementArtefact = await createArtefact({
      runId, userId, conversationId,
      type: 'tower_judgement',
      title: `Tower Judgement: ${verdict} (Step ${i + 1})`,
      summary: `Verdict: ${verdict} | Action: ${towerAction} | Trigger: ${towerVerdict.trigger} | Machine: ${machineLabel()} | Scrap: ${simOutput.scrap_rate_now}% vs target ${constraints.max_scrap_percent}%`,
      payload: {
        verdict,
        action: towerAction,
        reasons: towerVerdict.reasons,
        metrics: towerVerdict.metrics,
        trigger: towerVerdict.trigger,
        step_index: step.step_index,
        step_label: step.label,
        judged_artefact_id: stateArtefact.id,
        factory_local_judgement: true,
        scenario,
        machine_used: currentMachine,
        machine_label: machineLabel(),
      },
    });

    console.log(`${logPrefix} Tower verdict step ${i + 1}: ${verdict} → ${towerAction} (trigger: ${towerVerdict.trigger}, machine: ${machineLabel()})`);

    await logAFREvent({
      userId, runId, conversationId, clientRequestId,
      actionTaken: 'tower_verdict', status: towerAction === 'stop' ? 'failed' : 'success',
      taskGenerated: `Factory demo step ${i + 1}: Tower ${verdict}→${towerAction} (${towerVerdict.trigger}) on ${machineLabel()}`,
      runType: 'plan',
      metadata: { step_index: step.step_index, verdict, action: towerAction, trigger: towerVerdict.trigger, scrap: simOutput.scrap_rate_now, cause: simOutput.probable_cause, machine: currentMachine },
    }).catch(() => {});

    stepsCompleted = i + 1;

    if (towerAction === 'stop') {
      console.log(`${logPrefix} Tower STOP at step ${i + 1} (trigger: ${towerVerdict.trigger}, machine: ${machineLabel()}). Terminating.`);
      stoppedByTower = true;

      await createArtefact({
        runId, userId, conversationId,
        type: 'plan_result',
        title: `Factory Demo Result: STOPPED at Step ${i + 1}`,
        summary: `Tower stopped the run on ${machineLabel()} (${towerVerdict.trigger}). Scrap ${simOutput.scrap_rate_now}% (target ${constraints.max_scrap_percent}%). Cause: ${formatCause(simOutput.probable_cause)}.`,
        payload: {
          outcome: 'stopped',
          stopped_at_step: i + 1,
          final_scrap_rate: simOutput.scrap_rate_now,
          target_scrap: constraints.max_scrap_percent,
          achievable_floor: simOutput.achievable_scrap_floor,
          floor_above_target: isFloorAboveTarget,
          scenario,
          tower_verdict: verdict,
          stop_trigger: towerVerdict.trigger,
          plan_changed: planChanged,
          machine_switched: machineSwitched,
          final_machine: currentMachine,
          final_machine_label: machineLabel(),
          change_plan_trigger: changePlanTrigger,
          mitigation_attempts: mitigationAttempts,
          final_diagnosis: {
            probable_cause: simOutput.probable_cause,
            trend: simOutput.trend,
            energy_status: simOutput.energy_status,
          },
        },
      });
      break;
    }

    if (towerAction === 'change_plan' && i < steps.length - 1) {
      changePlanTrigger = towerVerdict.trigger;
      const defectShiftedNow = towerVerdict.trigger === 'defect_shift_mismatch';

      const previousMachineLabel = machineLabel();
      const previousMachine = currentMachine;

      if (currentMachine === 'primary') {
        currentMachine = 'alternate';
        machineSwitched = true;
        console.log(`${logPrefix} Tower CHANGE_PLAN (${towerVerdict.trigger}): SWITCHING from ${previousMachineLabel} to ${machineLabel()}`);
      }

      const selection = selectIntervention(simOutput.probable_cause, currentMitigation, scenario, defectShiftedNow);
      if (selection.intervention !== currentMitigation && mitigationAttempts < MAX_MITIGATION_SWITCHES) {
        const previousMitigation = currentMitigation;
        currentMitigation = selection.intervention;
        planChanged = true;
        mitigationAttempts++;
        console.log(`${logPrefix} Also switching mitigation from "${previousMitigation}" to "${selection.intervention}"`);
      }

      planChanged = true;
      mitigationAttempts = Math.max(mitigationAttempts, 1);

      await createArtefact({
        runId, userId, conversationId,
        type: 'plan',
        title: `Factory Demo Plan v${mitigationAttempts + 1}: Switch to ${machineLabel()}`,
        summary: `Tower change_plan (${towerVerdict.trigger}). Switching production from ${previousMachineLabel} to ${machineLabel()}. Mitigation: "${currentMitigation}".`,
        payload: {
          scenario,
          constraints,
          plan_version: mitigationAttempts + 1,
          previous_machine: previousMachine,
          previous_machine_label: previousMachineLabel,
          new_machine: currentMachine,
          new_machine_label: machineLabel(),
          new_machine_profile: currentMachineProfile(),
          previous_mitigation: steps[2].proposed_action,
          new_mitigation: currentMitigation,
          reason: `Tower change_plan at step ${i + 1} (trigger: ${towerVerdict.trigger}). ${machineLabel()} has: ${currentMachineProfile().notes}`,
          trigger: towerVerdict.trigger,
          diagnosis: {
            probable_cause: simOutput.probable_cause,
            trend: simOutput.trend,
            defect_shifted: defectShiftedNow,
          },
        },
      });
    }
  }

  if (!stoppedByTower) {
    const finalScrap = priorState?.scrap_rate_now ?? 0;
    const withinTarget = finalScrap <= constraints.max_scrap_percent;

    await createArtefact({
      runId, userId, conversationId,
      type: 'plan_result',
      title: `Factory Demo Result: ${withinTarget ? 'SUCCESS' : 'PARTIAL'}`,
      summary: `Completed all ${stepsCompleted} steps on ${machineLabel()}. Final scrap ${finalScrap}% (target ${constraints.max_scrap_percent}%). Cause: ${formatCause(priorState?.probable_cause ?? 'none')}.`,
      payload: {
        outcome: withinTarget ? 'success' : 'partial',
        steps_completed: stepsCompleted,
        final_scrap_rate: finalScrap,
        target_scrap: constraints.max_scrap_percent,
        achievable_floor: priorState?.achievable_scrap_floor ?? 0,
        scenario,
        plan_changed: planChanged,
        machine_switched: machineSwitched,
        final_machine: currentMachine,
        final_machine_label: machineLabel(),
        change_plan_trigger: changePlanTrigger,
        mitigation_used: currentMitigation,
        mitigation_attempts: mitigationAttempts,
        final_diagnosis: {
          probable_cause: priorState?.probable_cause ?? 'none',
          trend: priorState?.trend ?? 'stable',
          energy_status: priorState?.energy_status ?? 'within_limit',
        },
      },
    });
  }

  const causeLabel = formatCause(priorState?.probable_cause ?? 'none');
  const switchNote = machineSwitched ? ` Switched from ${machines.primary.label} to ${machines.alternate.label}.` : '';
  const summary = stoppedByTower
    ? `Factory demo stopped at step ${stepsCompleted} on ${machineLabel()}. Cause: ${causeLabel}. Scrap ${priorState?.scrap_rate_now}% exceeded target ${constraints.max_scrap_percent}%.${switchNote}`
    : `Factory demo completed ${stepsCompleted} steps on ${machineLabel()}. Cause: ${causeLabel}. Final scrap ${priorState?.scrap_rate_now}% (target ${constraints.max_scrap_percent}%).${switchNote}`;

  console.log(`${logPrefix} Demo complete: ${summary}`);

  await logAFREvent({
    userId, runId, conversationId, clientRequestId,
    actionTaken: 'factory_demo_completed', status: stoppedByTower ? 'failed' : 'success',
    taskGenerated: summary,
    runType: 'plan',
    metadata: { scenario, stepsCompleted, stoppedByTower, planChanged, machineSwitched, finalMachine: currentMachine, changePlanTrigger, cause: priorState?.probable_cause },
  }).catch(() => {});

  try {
    const narrativeResult = await generateRunNarrative({ runId, runType: 'factory_demo', userId, conversationId });
    console.log(`${logPrefix} TL;DR: ${narrativeResult.tldr}`);
    console.log(`${logPrefix} Narrative generated (${narrativeResult.narrative.length} chars)`);
  } catch (err: any) {
    console.error(`${logPrefix} Narrative generation failed (non-fatal): ${err.message}`);
  }

  return {
    success: !stoppedByTower,
    stepsCompleted,
    finalState: priorState,
    stoppedByTower,
    planChanged,
    machineSwitched,
    finalMachine: currentMachine,
    summary,
  };
}
