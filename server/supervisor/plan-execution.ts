/**
 * Plan Execution Route - POST /api/supervisor/execute-plan
 * 
 * Express route for Supervisor plan execution.
 * Validates request, returns 200 immediately, kicks off async execution.
 */

import { Router } from 'express';
import type { ExecutePlanRequest, ExecutePlanResponse } from './types/plan';
import { startPlanExecutionAsync } from './plan-executor';

export const planExecutionRouter = Router();

planExecutionRouter.post('/execute-plan', async (req, res) => {
  const startTime = Date.now();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log('[SUPERVISOR_EXECUTE_PLAN] Request received');
  console.log(`${'='.repeat(60)}\n`);
  
  try {
    const body = req.body as ExecutePlanRequest;
    
    if (!body.planId) {
      console.error('[SUPERVISOR_EXECUTE_PLAN] Missing planId');
      return res.status(400).json({
        ok: false,
        error: 'Missing required plan execution data: planId'
      } as ExecutePlanResponse);
    }
    
    if (!body.userId) {
      console.error('[SUPERVISOR_EXECUTE_PLAN] Missing userId');
      return res.status(400).json({
        ok: false,
        error: 'Missing required plan execution data: userId'
      } as ExecutePlanResponse);
    }
    
    if (!body.goal) {
      console.error('[SUPERVISOR_EXECUTE_PLAN] Missing goal');
      return res.status(400).json({
        ok: false,
        error: 'Missing required plan execution data: goal'
      } as ExecutePlanResponse);
    }
    
    if (!body.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
      console.error('[SUPERVISOR_EXECUTE_PLAN] Missing or empty steps');
      return res.status(400).json({
        ok: false,
        error: 'Missing required plan execution data: steps'
      } as ExecutePlanResponse);
    }
    
    console.log('[SUPERVISOR_EXECUTE_PLAN] Validated request:');
    console.log(`  planId: ${body.planId}`);
    console.log(`  userId: ${body.userId}`);
    console.log(`  goal: ${body.goal}`);
    console.log(`  steps: ${body.steps.length}`);
    console.log(`  conversationId: ${body.conversationId || 'N/A'}`);
    
    startPlanExecutionAsync({
      planId: body.planId,
      userId: body.userId,
      conversationId: body.conversationId,
      goal: body.goal,
      steps: body.steps,
      toolMetadata: body.toolMetadata
    });
    
    const elapsed = Date.now() - startTime;
    console.log(`[SUPERVISOR_EXECUTE_PLAN] Returning immediately, execution kicked off (${elapsed}ms)`);
    
    return res.status(200).json({
      ok: true,
      planId: body.planId,
      status: 'executing'
    } as ExecutePlanResponse);
    
  } catch (error: any) {
    console.error('[SUPERVISOR_EXECUTE_PLAN] Error:', error.message);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Internal server error'
    } as ExecutePlanResponse);
  }
});
