import { storage } from '../storage';
import { logAFREvent } from './afr-logger';
import type { Artefact } from '../schema';

export interface CreateArtefactParams {
  runId: string;
  type: string;
  title: string;
  summary?: string;
  payload?: Record<string, unknown>;
  userId: string;
  conversationId?: string;
}

export async function createArtefact(params: CreateArtefactParams): Promise<Artefact> {
  const { runId, type, title, summary, payload, userId, conversationId } = params;

  let artefact: Artefact;
  try {
    artefact = await storage.createArtefact({
      runId,
      type,
      title,
      summary: summary || null,
      payloadJson: payload || null,
    });
    console.log(`[ARTEFACT_WRITE] run_id=${runId} type=${type} ok=true id=${artefact.id}`);
  } catch (err: any) {
    console.error(`[ARTEFACT_WRITE] run_id=${runId} type=${type} ok=false err=${err.message}`);
    throw err;
  }

  await logAFREvent({
    userId,
    runId,
    conversationId,
    actionTaken: 'artefact_created',
    status: 'success',
    taskGenerated: `Artefact created: ${title}`,
    runType: 'plan',
    metadata: {
      artefactId: artefact.id,
      artefactType: type,
      title,
      summary: summary || null,
    },
  });

  return artefact;
}
