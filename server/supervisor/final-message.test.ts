import { describe, it, expect } from 'vitest';
import type { DeliverySummaryPayload } from './delivery-summary';

const SUPERVISOR_NEUTRAL_MESSAGE = 'Run complete. Results are available.';
const SUPERVISOR_FAIL_MESSAGE = 'The search encountered an issue and could not complete. You can view partial results if any are available.';

function makeMockDeliverySummary(overrides?: Partial<DeliverySummaryPayload>): DeliverySummaryPayload {
  return {
    requested_count: 5,
    hard_constraints: ['business_type=pubs', 'location=Arundel'],
    soft_constraints: [],
    plan_versions: [{ version: 1, changes_made: ['Initial plan'] }],
    soft_relaxations: [],
    delivered_exact: [
      { entity_id: 'place_1', name: 'The Swan', address: '1 High St', match_level: 'exact', soft_violations: [] },
      { entity_id: 'place_2', name: 'The Eagle', address: '2 High St', match_level: 'exact', soft_violations: [] },
    ],
    delivered_closest: [],
    delivered_exact_count: 2,
    delivered_total_count: 2,
    shortfall: 3,
    status: 'PARTIAL' as any,
    tower_verdict: 'pass',
    cvl_summary: null,
    stop_reason: null,
    suggested_next_question: null,
    cvl_verified_exact_count: 2,
    cvl_unverifiable_count: 0,
    ...overrides,
  };
}

interface FinalMessageParams {
  taskId: string;
  conversationId: string;
  runId: string;
  response: string;
  leadIds: string[];
  capabilities: string[];
  runFailed: boolean;
  failureReason?: string;
  deliverySummary?: DeliverySummaryPayload | null;
  towerVerdict?: string | null;
  leads?: Array<{ name: string; address: string; phone: string | null; website: string | null; placeId: string }>;
}

function buildFinalMessage(params: FinalMessageParams) {
  const { taskId, runId, response, leadIds, capabilities, runFailed, failureReason, deliverySummary, towerVerdict, leads } = params;
  const dsStatus = deliverySummary?.status ?? (runFailed ? 'STOP' : 'PASS');
  return {
    role: 'assistant',
    content: response,
    source: 'supervisor',
    metadata: {
      supervisor_task_id: taskId,
      run_id: runId,
      capabilities,
      lead_ids: leadIds,
      run_lane: true,
      status: dsStatus,
      ...(deliverySummary ? { deliverySummary } : {}),
      ...(towerVerdict ? { towerVerdict } : {}),
      ...(leads && leads.length > 0 ? { leads } : {}),
      ...(runFailed ? { run_failed: true, failure_reason: failureReason } : {}),
    },
  };
}

describe('Final chat message contract', () => {
  it('PASS outcome: message includes deliverySummary, towerVerdict, leads, and run_id', () => {
    const ds = makeMockDeliverySummary({ status: 'PASS' as any });
    const msg = buildFinalMessage({
      taskId: 'task-1',
      conversationId: 'conv-1',
      runId: 'run-pass-1',
      response: SUPERVISOR_NEUTRAL_MESSAGE,
      leadIds: ['lead-1', 'lead-2'],
      capabilities: ['lead_generation', 'tower_validated'],
      runFailed: false,
      deliverySummary: ds,
      towerVerdict: 'pass',
      leads: [
        { name: 'The Swan', address: '1 High St', phone: null, website: null, placeId: 'place_1' },
        { name: 'The Eagle', address: '2 High St', phone: null, website: null, placeId: 'place_2' },
      ],
    });

    expect(msg.role).toBe('assistant');
    expect(msg.source).toBe('supervisor');
    expect(msg.metadata.run_id).toBe('run-pass-1');
    expect(msg.metadata.deliverySummary).toBeDefined();
    expect(msg.metadata.deliverySummary!.status).toBe('PASS');
    expect(msg.metadata.deliverySummary!.delivered_exact_count).toBe(2);
    expect(msg.metadata.deliverySummary!.requested_count).toBe(5);
    expect(msg.metadata.towerVerdict).toBe('pass');
    expect(msg.metadata.leads).toHaveLength(2);
    expect(msg.metadata.status).toBe('PASS');
    expect(msg.metadata.capabilities).toContain('tower_validated');
    expect(msg.metadata.run_failed).toBeUndefined();
  });

  it('STOP outcome: message includes deliverySummary with stop_reason', () => {
    const ds = makeMockDeliverySummary({
      status: 'STOP' as any,
      stop_reason: 'Tower verdict: stop',
      delivered_exact_count: 0,
      delivered_total_count: 0,
      shortfall: 5,
    });
    const msg = buildFinalMessage({
      taskId: 'task-2',
      conversationId: 'conv-2',
      runId: 'run-stop-1',
      response: SUPERVISOR_NEUTRAL_MESSAGE,
      leadIds: [],
      capabilities: ['lead_generation', 'tower_validated'],
      runFailed: false,
      deliverySummary: ds,
      towerVerdict: 'stop',
      leads: [],
    });

    expect(msg.metadata.run_id).toBe('run-stop-1');
    expect(msg.metadata.deliverySummary).toBeDefined();
    expect(msg.metadata.deliverySummary!.status).toBe('STOP');
    expect(msg.metadata.deliverySummary!.stop_reason).toBe('Tower verdict: stop');
    expect(msg.metadata.status).toBe('STOP');
    expect(msg.metadata.towerVerdict).toBe('stop');
    expect(msg.metadata.run_failed).toBeUndefined();
  });

  it('FAIL outcome: message has status=STOP, run_failed flag, and no deliverySummary when crash', () => {
    const msg = buildFinalMessage({
      taskId: 'task-3',
      conversationId: 'conv-3',
      runId: 'run-fail-1',
      response: SUPERVISOR_FAIL_MESSAGE,
      leadIds: [],
      capabilities: ['lead_generation', 'run_failed'],
      runFailed: true,
      failureReason: 'Tower API timeout',
      deliverySummary: null,
      towerVerdict: 'error',
      leads: [],
    });

    expect(msg.metadata.run_id).toBe('run-fail-1');
    expect(msg.metadata.status).toBe('STOP');
    expect(msg.metadata.deliverySummary).toBeUndefined();
    expect(msg.metadata.towerVerdict).toBe('error');
    expect(msg.metadata.run_failed).toBe(true);
    expect(msg.metadata.failure_reason).toBe('Tower API timeout');
    expect(msg.metadata.capabilities).toContain('run_failed');
  });

  it('message always includes run_id and status regardless of outcome', () => {
    const outcomes = [
      {
        runFailed: false,
        response: SUPERVISOR_NEUTRAL_MESSAGE,
        capabilities: ['lead_generation', 'tower_validated'],
        deliverySummary: makeMockDeliverySummary({ status: 'PASS' as any }),
        towerVerdict: 'pass',
      },
      {
        runFailed: true,
        response: SUPERVISOR_FAIL_MESSAGE,
        capabilities: ['lead_generation', 'run_failed'],
        deliverySummary: null as DeliverySummaryPayload | null,
        towerVerdict: 'error',
      },
    ];

    for (const outcome of outcomes) {
      const runId = `run-${Date.now()}-${Math.random()}`;
      const msg = buildFinalMessage({
        taskId: 'task-x',
        conversationId: 'conv-x',
        runId,
        response: outcome.response,
        leadIds: [],
        capabilities: outcome.capabilities,
        runFailed: outcome.runFailed,
        failureReason: outcome.runFailed ? 'test error' : undefined,
        deliverySummary: outcome.deliverySummary,
        towerVerdict: outcome.towerVerdict,
        leads: [],
      });
      expect(msg.metadata.run_id).toBe(runId);
      expect(typeof msg.metadata.status).toBe('string');
      expect(['PASS', 'PARTIAL', 'STOP']).toContain(msg.metadata.status);
    }
  });

  it('PASS with deliverySummary: message carries enough data for RunResultBubble rendering', () => {
    const ds = makeMockDeliverySummary({
      status: 'PASS' as any,
      requested_count: 5,
      delivered_exact_count: 5,
      delivered_total_count: 5,
      shortfall: 0,
    });
    const msg = buildFinalMessage({
      taskId: 'task-bubble',
      conversationId: 'conv-bubble',
      runId: 'run-bubble-1',
      response: SUPERVISOR_NEUTRAL_MESSAGE,
      leadIds: ['l1', 'l2', 'l3', 'l4', 'l5'],
      capabilities: ['lead_generation', 'tower_validated'],
      runFailed: false,
      deliverySummary: ds,
      towerVerdict: 'pass',
      leads: [
        { name: 'Pub A', address: '1 St', phone: '+1', website: 'http://a.com', placeId: 'p1' },
        { name: 'Pub B', address: '2 St', phone: '+2', website: 'http://b.com', placeId: 'p2' },
      ],
    });

    const md = msg.metadata;
    expect(md.run_id).toBe('run-bubble-1');
    expect(md.status).toBe('PASS');
    expect(md.deliverySummary).toBeDefined();
    expect(md.deliverySummary!.requested_count).toBe(5);
    expect(md.deliverySummary!.delivered_exact_count).toBe(5);
    expect(md.deliverySummary!.shortfall).toBe(0);
    expect(md.deliverySummary!.hard_constraints).toEqual(['business_type=pubs', 'location=Arundel']);
    expect(md.towerVerdict).toBe('pass');
    expect(md.leads).toHaveLength(2);
    expect(md.leads![0].name).toBe('Pub A');
    expect(md.lead_ids).toHaveLength(5);
  });

  it('integration: getRunSnapshot returns data for run_id alignment', async () => {
    const { storage } = await import('../storage');

    const runId = `final_msg_test_${Date.now()}`;

    try {
      await storage.createAgentRun({
        id: runId,
        userId: 'test-user',
        status: 'completed',
        terminalState: 'completed',
        metadata: { test: true, source: 'final-message-test' },
      });
    } catch (e: any) {
      console.log(`[TEST] agent_run creation skipped: ${e.message}`);
    }

    const snapshot = await storage.getRunSnapshot(runId);
    expect(snapshot.run_id).toBe(runId);
  });
});
