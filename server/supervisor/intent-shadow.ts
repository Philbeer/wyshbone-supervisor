import { extractCanonicalIntent, type IntentExtractionResult } from './intent-extractor';
import { createArtefact } from './artefacts';
import { logAFREvent } from './afr-logger';

export type IntentExtractorMode = 'off' | 'shadow' | 'active' | 'strict';

export function getIntentExtractorMode(): IntentExtractorMode {
  const raw = (process.env.INTENT_EXTRACTOR_MODE || 'off').toLowerCase().trim();
  if (raw === 'shadow' || raw === 'active' || raw === 'strict') return raw;
  return 'off';
}

export function isProbeEnabled(): boolean {
  return (process.env.INTENT_EXTRACTOR_PROBE || '').toLowerCase().trim() === 'true';
}

export async function emitProbe(
  actionTaken: string,
  userId: string,
  runId: string,
  conversationId: string | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!isProbeEnabled()) return;
  try {
    await logAFREvent({
      userId,
      runId,
      conversationId,
      actionTaken,
      status: 'success',
      taskGenerated: `Probe: ${actionTaken}`,
      runType: 'plan',
      metadata,
    });
    console.log(`[PROBE] ${actionTaken} emitted for runId=${runId}`);
  } catch (err: any) {
    console.warn(`[PROBE] ${actionTaken} emit failed: ${err.message}`);
  }
}

export interface ShadowIntentResult {
  ran: boolean;
  extraction: IntentExtractionResult | null;
  error: string | null;
}

export async function runIntentExtractorShadow(
  userMessage: string,
  runId: string,
  userId: string,
  conversationId?: string,
  conversationContext?: string,
): Promise<ShadowIntentResult> {
  const mode = getIntentExtractorMode();

  if (mode === 'off') {
    return { ran: false, extraction: null, error: null };
  }

  if (mode === 'active' || mode === 'strict') {
    console.log(`[INTENT_EXTRACTOR] mode=${mode} — not yet wired, skipping`);
    await emitDiagnosticArtefact(runId, userId, conversationId, mode, false, false, null);
    return { ran: false, extraction: null, error: null };
  }

  console.log(`[INTENT_EXTRACTOR_SHADOW] mode=shadow — running extractor for runId=${runId}`);

  let extraction: IntentExtractionResult | null = null;
  let extractionError: string | null = null;

  try {
    extraction = await extractCanonicalIntent(userMessage, conversationContext);
  } catch (err: any) {
    extractionError = err.message;
    console.error(`[INTENT_EXTRACTOR_SHADOW] extraction failed: ${err.message}`);
  }

  const validationOk = extraction?.validation.ok ?? false;
  const validationErrors = extraction?.validation.errors ?? (extractionError ? [`LLM call failed: ${extractionError}`] : ['extraction did not run']);
  const model = extraction?.model ?? 'none';
  const durationMs = extraction?.duration_ms ?? 0;

  console.log(
    `[INTENT_EXTRACTOR_SHADOW] model=${model} valid=${validationOk} duration=${durationMs}ms` +
    (validationErrors.length > 0 ? ` errors=[${validationErrors.join('; ')}]` : '')
  );

  try {
    await createArtefact({
      runId,
      type: 'intent_extracted_shadow',
      title: 'Shadow Intent Extraction',
      summary: validationOk
        ? `Extracted intent: ${extraction?.validation.intent?.mission_type ?? 'unknown'}`
        : extractionError
          ? `Extraction error: ${extractionError.substring(0, 100)}`
          : `Validation failed: ${validationErrors.length} error(s)`,
      payload: {
        input_message: userMessage,
        extracted_intent: validationOk ? extraction!.validation.intent : null,
        validation_ok: validationOk,
        validation_errors: validationErrors,
        model,
        duration_ms: durationMs,
      },
      userId,
      conversationId,
    });
    console.log(`[INTENT_EXTRACTOR_SHADOW] intent_extracted_shadow artefact emitted for runId=${runId}`);
  } catch (err: any) {
    console.error(`[INTENT_EXTRACTOR_SHADOW] artefact emit FAILED: ${err.message}`);
  }

  await emitDiagnosticArtefact(runId, userId, conversationId, mode, true, validationOk, extractionError);

  return { ran: true, extraction, error: extractionError };
}

async function emitDiagnosticArtefact(
  runId: string,
  userId: string,
  conversationId: string | undefined,
  mode: IntentExtractorMode,
  executed: boolean,
  validationPassed: boolean,
  error: string | null,
): Promise<void> {
  try {
    await createArtefact({
      runId,
      type: 'diagnostic',
      title: 'Intent Extractor Diagnostic',
      summary: `mode=${mode} executed=${executed} valid=${validationPassed}`,
      payload: {
        intent_extractor_mode: mode,
        extractor_executed: executed,
        validation_passed: validationPassed,
        error: error ?? null,
      },
      userId,
      conversationId,
    });
  } catch (err: any) {
    console.warn(`[INTENT_EXTRACTOR_SHADOW] diagnostic artefact emit failed: ${err.message}`);
  }
}
