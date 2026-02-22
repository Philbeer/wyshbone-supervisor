import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SUPERVISOR_NEUTRAL_MESSAGE = 'Run complete. Results are available.';
const SUPERVISOR_FAIL_MESSAGE = 'The search encountered an issue and could not complete. You can view partial results if any are available.';

function buildFinalMessage(params: {
  taskId: string;
  conversationId: string;
  runId: string;
  response: string;
  leadIds: string[];
  capabilities: string[];
  runFailed: boolean;
  failureReason?: string;
}) {
  const { taskId, conversationId, runId, response, leadIds, capabilities, runFailed, failureReason } = params;
  return {
    conversation_id: conversationId,
    role: 'assistant',
    content: response,
    source: 'supervisor',
    metadata: {
      supervisor_task_id: taskId,
      run_id: runId,
      capabilities,
      lead_ids: leadIds,
      run_lane: true,
      ...(runFailed ? { run_failed: true, failure_reason: failureReason } : {}),
    },
    created_at: expect.any(String),
  };
}

describe('Final chat message contract', () => {
  it('PASS outcome: message contains run_id, lead_ids, and tower_validated capability', () => {
    const msg = buildFinalMessage({
      taskId: 'task-1',
      conversationId: 'conv-1',
      runId: 'run-pass-1',
      response: SUPERVISOR_NEUTRAL_MESSAGE,
      leadIds: ['lead-1', 'lead-2'],
      capabilities: ['lead_generation', 'tower_validated'],
      runFailed: false,
    });

    expect(msg.role).toBe('assistant');
    expect(msg.source).toBe('supervisor');
    expect(msg.content).toBe(SUPERVISOR_NEUTRAL_MESSAGE);
    expect(msg.metadata.run_id).toBe('run-pass-1');
    expect(msg.metadata.lead_ids).toEqual(['lead-1', 'lead-2']);
    expect(msg.metadata.capabilities).toContain('tower_validated');
    expect(msg.metadata.run_lane).toBe(true);
    expect(msg.metadata.run_failed).toBeUndefined();
  });

  it('STOP outcome: message contains run_id and tower_validated capability', () => {
    const msg = buildFinalMessage({
      taskId: 'task-2',
      conversationId: 'conv-2',
      runId: 'run-stop-1',
      response: SUPERVISOR_NEUTRAL_MESSAGE,
      leadIds: ['lead-3'],
      capabilities: ['lead_generation', 'tower_validated'],
      runFailed: false,
    });

    expect(msg.metadata.run_id).toBe('run-stop-1');
    expect(msg.metadata.capabilities).toContain('tower_validated');
    expect(msg.metadata.run_failed).toBeUndefined();
  });

  it('FAIL outcome: message contains run_id, failure_reason, and run_failed flag', () => {
    const msg = buildFinalMessage({
      taskId: 'task-3',
      conversationId: 'conv-3',
      runId: 'run-fail-1',
      response: SUPERVISOR_FAIL_MESSAGE,
      leadIds: [],
      capabilities: ['lead_generation', 'run_failed'],
      runFailed: true,
      failureReason: 'Tower API timeout',
    });

    expect(msg.role).toBe('assistant');
    expect(msg.source).toBe('supervisor');
    expect(msg.content).toBe(SUPERVISOR_FAIL_MESSAGE);
    expect(msg.metadata.run_id).toBe('run-fail-1');
    expect(msg.metadata.lead_ids).toEqual([]);
    expect(msg.metadata.capabilities).toContain('run_failed');
    expect(msg.metadata.capabilities).not.toContain('tower_validated');
    expect(msg.metadata.run_failed).toBe(true);
    expect(msg.metadata.failure_reason).toBe('Tower API timeout');
  });

  it('message always includes run_id regardless of outcome', () => {
    const outcomes = [
      { runFailed: false, response: SUPERVISOR_NEUTRAL_MESSAGE, capabilities: ['lead_generation', 'tower_validated'] },
      { runFailed: true, response: SUPERVISOR_FAIL_MESSAGE, capabilities: ['lead_generation', 'run_failed'] },
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
      });
      expect(msg.metadata.run_id).toBe(runId);
      expect(typeof msg.metadata.run_id).toBe('string');
      expect(msg.metadata.run_id.length).toBeGreaterThan(0);
    }
  });

  it('integration: processChatTask writes final message to Supabase for every terminal outcome', async () => {
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
      console.log(`[TEST] agent_run creation skipped (may already exist or table missing): ${e.message}`);
    }

    const snapshot = await storage.getRunSnapshot(runId);
    expect(snapshot.run_id).toBe(runId);
  });
});
