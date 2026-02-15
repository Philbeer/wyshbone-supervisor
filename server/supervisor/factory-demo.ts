/**
 * Factory Demo Runner — Executes a fixed 3-step injection-moulding demo plan.
 *
 * Step 1: Baseline assessment
 * Step 2: Production drift (scrap rises above threshold with moisture_high or tool_worn)
 * Step 3: Mitigation (success or failure depending on scenario + constraints)
 *
 * Each step writes:
 *   - factory_state artefact (tool output + step_index)
 *   - factory_decision artefact (decision + reason + expected impact)
 *
 * Tower judgement is called after every step. Reactions:
 *   - CHANGE_PLAN → switch mitigation strategy and continue
 *   - STOP → terminate and write plan_result
 *   - continue → proceed to next step
 */

import { randomUUID } from 'crypto';
import {
  runFactorySim,
  buildDemoSteps,
  ALTERNATIVE_MITIGATIONS,
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
}

function judgeFactoryStep(
  stepIndex: number,
  simOutput: FactorySimOutput,
  maxScrapPercent: number,
  scenario: DemoScenario,
): FactoryTowerVerdict {
  const scrap = simOutput.scrap_rate_now;
  const floor = simOutput.achievable_scrap_floor;
  const aboveTarget = scrap > maxScrapPercent;
  const floorAboveTarget = floor > maxScrapPercent;

  if (stepIndex === 0) {
    if (aboveTarget && floorAboveTarget) {
      return {
        verdict: 'fail', action: 'stop',
        reasons: [`Baseline scrap ${scrap}% already above target ${maxScrapPercent}%. Achievable floor ${floor}% is also above target — impossible to meet constraint.`],
        metrics: { scrap_rate: scrap, target: maxScrapPercent, floor, step: stepIndex },
      };
    }
    return {
      verdict: 'pass', action: 'continue',
      reasons: [`Baseline scrap ${scrap}% acceptable. Proceeding to monitor for drift.`],
      metrics: { scrap_rate: scrap, target: maxScrapPercent, floor, step: stepIndex },
    };
  }

  if (stepIndex === 1) {
    if (aboveTarget && floorAboveTarget) {
      return {
        verdict: 'fail', action: 'stop',
        reasons: [`Scrap ${scrap}% above target ${maxScrapPercent}%. Floor ${floor}% makes target unachievable under current conditions.`],
        metrics: { scrap_rate: scrap, target: maxScrapPercent, floor, step: stepIndex, defect: simOutput.defect_type },
      };
    }
    if (aboveTarget) {
      return {
        verdict: 'warn', action: 'change_plan',
        reasons: [`Drift detected: scrap ${scrap}% exceeds target ${maxScrapPercent}%. Floor ${floor}% suggests recovery is possible with different mitigation.`],
        metrics: { scrap_rate: scrap, target: maxScrapPercent, floor, step: stepIndex, defect: simOutput.defect_type },
      };
    }
    return {
      verdict: 'pass', action: 'continue',
      reasons: [`Scrap ${scrap}% within target ${maxScrapPercent}%. No intervention required.`],
      metrics: { scrap_rate: scrap, target: maxScrapPercent, floor, step: stepIndex },
    };
  }

  if (aboveTarget && floorAboveTarget) {
    return {
      verdict: 'fail', action: 'stop',
      reasons: [`Mitigation insufficient. Scrap ${scrap}% still above target ${maxScrapPercent}%. Floor ${floor}% confirms target is unachievable.`],
      metrics: { scrap_rate: scrap, target: maxScrapPercent, floor, step: stepIndex },
    };
  }
  if (aboveTarget) {
    return {
      verdict: 'warn', action: 'change_plan',
      reasons: [`Scrap ${scrap}% still above target ${maxScrapPercent}% after mitigation. Floor ${floor}% means a different strategy could work.`],
      metrics: { scrap_rate: scrap, target: maxScrapPercent, floor, step: stepIndex },
    };
  }
  return {
    verdict: 'pass', action: 'continue',
    reasons: [`Mitigation successful. Scrap ${scrap}% within target ${maxScrapPercent}%.`],
    metrics: { scrap_rate: scrap, target: maxScrapPercent, floor, step: stepIndex },
  };
}

export interface FactoryDemoParams {
  runId: string;
  userId: string;
  conversationId?: string;
  clientRequestId?: string;
  scenario?: DemoScenario;
  maxScrapPercent?: number;
}

export interface FactoryDemoResult {
  success: boolean;
  stepsCompleted: number;
  finalState: FactorySimOutput | null;
  stoppedByTower: boolean;
  planChanged: boolean;
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
  } = params;

  const logPrefix = `[FACTORY_DEMO]`;
  console.log(`${logPrefix} Starting demo — scenario=${scenario} max_scrap=${maxScrapPercent}% runId=${runId}`);

  const constraints = { max_scrap_percent: maxScrapPercent };
  const steps = buildDemoSteps(scenario);
  const goal = `Injection moulding demo: keep scrap below ${maxScrapPercent}% under scenario "${scenario}"`;

  await logAFREvent({
    userId, runId, conversationId, clientRequestId,
    actionTaken: 'factory_demo_started', status: 'pending',
    taskGenerated: `Factory demo: ${scenario}, max scrap ${maxScrapPercent}%`,
    runType: 'plan',
    metadata: { scenario, maxScrapPercent, stepCount: steps.length },
  }).catch(() => {});

  const planArtefact = await createArtefact({
    runId, userId, conversationId,
    type: 'plan',
    title: `Factory Demo Plan: ${scenario}`,
    summary: `3-step injection moulding simulation (${scenario}), max scrap ${maxScrapPercent}%`,
    payload: {
      scenario,
      constraints,
      steps: steps.map(s => ({ step: s.step_index + 1, label: s.label, action: s.proposed_action })),
      plan_version: 1,
    },
  });

  let priorState: FactorySimOutput | null = null;
  let baselineScrap: number | null = null;
  let stepsCompleted = 0;
  let stoppedByTower = false;
  let planChanged = false;
  let currentMitigation = steps[2].proposed_action;
  let mitigationAttempts = 0;
  const MAX_MITIGATION_SWITCHES = 2;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const action = i === 2 ? currentMitigation : step.proposed_action;

    console.log(`${logPrefix} Step ${i + 1}/${steps.length}: ${step.label} (action=${action})`);

    const simInput: FactorySimInput = {
      scenario,
      constraints,
      step_index: step.step_index,
      prior_state: priorState,
      proposed_action: action,
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
      driftReason = `Scrap increased by ${delta}pp from baseline ${baselineScrap}% to ${simOutput.scrap_rate_now}%. Defect: ${simOutput.defect_type}. ${simOutput.notes}`;
    } else if (i > 0) {
      driftReason = `Scrap ${simOutput.scrap_rate_now}% is at or below baseline ${baselineScrap}%. No adverse drift.`;
    }

    const stateArtefact = await createArtefact({
      runId, userId, conversationId,
      type: 'factory_state',
      title: `Factory State: Step ${i + 1} — ${step.label}`,
      summary: `scrap=${simOutput.scrap_rate_now}% defect=${simOutput.defect_type} energy=${simOutput.energy_kwh_per_good_part}kWh floor=${simOutput.achievable_scrap_floor}%`,
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
      },
    });

    const isAboveTarget = simOutput.scrap_rate_now > constraints.max_scrap_percent;
    const isFloorAboveTarget = simOutput.achievable_scrap_floor > constraints.max_scrap_percent;
    let decision: string;
    let reason: string;
    let expectedImpact: string;

    if (i === 0) {
      decision = 'proceed_to_monitoring';
      reason = `Baseline scrap ${simOutput.scrap_rate_now}% recorded. Floor=${simOutput.achievable_scrap_floor}%.`;
      expectedImpact = 'Drift expected in next cycle batch.';
    } else if (i === 1) {
      decision = isAboveTarget ? 'intervene' : 'continue_monitoring';
      reason = isAboveTarget
        ? `Scrap ${simOutput.scrap_rate_now}% exceeds target ${constraints.max_scrap_percent}%. Defect: ${simOutput.defect_type}.`
        : `Scrap ${simOutput.scrap_rate_now}% still within target.`;
      expectedImpact = isAboveTarget
        ? `Mitigation "${currentMitigation}" should reduce scrap toward floor ${simOutput.achievable_scrap_floor}%.`
        : 'No intervention needed.';
    } else {
      const improved = simOutput.scrap_rate_now < (previousState?.scrap_rate_now ?? simOutput.scrap_rate_now);
      decision = isAboveTarget ? 'escalate' : 'accept';
      reason = isAboveTarget
        ? `After "${action}", scrap=${simOutput.scrap_rate_now}% still above target. Floor=${simOutput.achievable_scrap_floor}%.`
        : `Mitigation "${action}" succeeded. Scrap=${simOutput.scrap_rate_now}% within target.`;
      expectedImpact = isAboveTarget
        ? (isFloorAboveTarget
          ? `Floor ${simOutput.achievable_scrap_floor}% > target ${constraints.max_scrap_percent}% — target is UNACHIEVABLE with current conditions.`
          : 'Alternative mitigation may help.')
        : 'Production can continue normally.';
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
      },
    });

    console.log(`${logPrefix} Step ${i + 1} artefacts written: state=${stateArtefact.id} decision=${decisionArtefact.id}`);

    const towerVerdict = judgeFactoryStep(step.step_index, simOutput, constraints.max_scrap_percent, scenario);
    const verdict = towerVerdict.verdict;
    const towerAction = towerVerdict.action;

    const judgementArtefact = await createArtefact({
      runId, userId, conversationId,
      type: 'tower_judgement',
      title: `Tower Judgement: ${verdict} (Step ${i + 1})`,
      summary: `Verdict: ${verdict} | Action: ${towerAction} | Scrap: ${simOutput.scrap_rate_now}% vs target ${constraints.max_scrap_percent}%`,
      payload: {
        verdict,
        action: towerAction,
        reasons: towerVerdict.reasons,
        metrics: towerVerdict.metrics,
        step_index: step.step_index,
        step_label: step.label,
        judged_artefact_id: stateArtefact.id,
        factory_local_judgement: true,
        scenario,
      },
    });

    console.log(`${logPrefix} Tower verdict step ${i + 1}: ${verdict} → ${towerAction}`);

    await logAFREvent({
      userId, runId, conversationId, clientRequestId,
      actionTaken: 'tower_verdict', status: towerAction === 'stop' ? 'failed' : 'success',
      taskGenerated: `Factory demo step ${i + 1}: Tower ${verdict}→${towerAction}`,
      runType: 'plan',
      metadata: { step_index: step.step_index, verdict, action: towerAction, scrap: simOutput.scrap_rate_now },
    }).catch(() => {});

    stepsCompleted = i + 1;

    if (towerAction === 'stop') {
      console.log(`${logPrefix} Tower STOP at step ${i + 1}. Terminating.`);
      stoppedByTower = true;

      await createArtefact({
        runId, userId, conversationId,
        type: 'plan_result',
        title: `Factory Demo Result: STOPPED at Step ${i + 1}`,
        summary: `Tower stopped the run. Scrap ${simOutput.scrap_rate_now}% (target ${constraints.max_scrap_percent}%). ${isFloorAboveTarget ? 'Floor above target — unachievable.' : ''}`,
        payload: {
          outcome: 'stopped',
          stopped_at_step: i + 1,
          final_scrap_rate: simOutput.scrap_rate_now,
          target_scrap: constraints.max_scrap_percent,
          achievable_floor: simOutput.achievable_scrap_floor,
          floor_above_target: isFloorAboveTarget,
          scenario,
          tower_verdict: verdict,
          plan_changed: planChanged,
          mitigation_attempts: mitigationAttempts,
        },
      });
      break;
    }

    if (towerAction === 'change_plan' && i < steps.length - 1) {
      const alternatives = ALTERNATIVE_MITIGATIONS[scenario] || [];
      const nextMitigation = alternatives.find(a => a !== currentMitigation);

      if (nextMitigation && mitigationAttempts < MAX_MITIGATION_SWITCHES) {
        console.log(`${logPrefix} Tower CHANGE_PLAN: switching mitigation from "${currentMitigation}" to "${nextMitigation}"`);
        currentMitigation = nextMitigation;
        planChanged = true;
        mitigationAttempts++;

        await createArtefact({
          runId, userId, conversationId,
          type: 'plan',
          title: `Factory Demo Plan v${mitigationAttempts + 1}: Strategy Change`,
          summary: `Tower requested plan change. Mitigation switched to "${nextMitigation}".`,
          payload: {
            scenario,
            constraints,
            plan_version: mitigationAttempts + 1,
            previous_mitigation: steps[2].proposed_action,
            new_mitigation: nextMitigation,
            reason: `Tower change_plan at step ${i + 1}`,
          },
        });
      } else {
        console.log(`${logPrefix} Tower CHANGE_PLAN but no alternative mitigations available. Continuing.`);
      }
    }
  }

  if (!stoppedByTower) {
    const finalScrap = priorState?.scrap_rate_now ?? 0;
    const withinTarget = finalScrap <= constraints.max_scrap_percent;

    await createArtefact({
      runId, userId, conversationId,
      type: 'plan_result',
      title: `Factory Demo Result: ${withinTarget ? 'SUCCESS' : 'PARTIAL'}`,
      summary: `Completed all ${stepsCompleted} steps. Final scrap ${finalScrap}% (target ${constraints.max_scrap_percent}%).`,
      payload: {
        outcome: withinTarget ? 'success' : 'partial',
        steps_completed: stepsCompleted,
        final_scrap_rate: finalScrap,
        target_scrap: constraints.max_scrap_percent,
        achievable_floor: priorState?.achievable_scrap_floor ?? 0,
        scenario,
        plan_changed: planChanged,
        mitigation_used: currentMitigation,
        mitigation_attempts: mitigationAttempts,
      },
    });
  }

  const summary = stoppedByTower
    ? `Factory demo stopped by Tower at step ${stepsCompleted}. Scrap ${priorState?.scrap_rate_now}% exceeded target ${constraints.max_scrap_percent}%.`
    : `Factory demo completed ${stepsCompleted} steps. Final scrap ${priorState?.scrap_rate_now}% (target ${constraints.max_scrap_percent}%).`;

  console.log(`${logPrefix} Demo complete: ${summary}`);

  await logAFREvent({
    userId, runId, conversationId, clientRequestId,
    actionTaken: 'factory_demo_completed', status: stoppedByTower ? 'failed' : 'success',
    taskGenerated: summary,
    runType: 'plan',
    metadata: { scenario, stepsCompleted, stoppedByTower, planChanged },
  }).catch(() => {});

  try {
    const narrativeResult = await generateRunNarrative({ runId, runType: 'factory_demo', userId, conversationId });
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
    summary,
  };
}
