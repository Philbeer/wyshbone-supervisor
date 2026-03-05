import { extractCanonicalIntent, type IntentExtractionResult } from './intent-extractor';
import { createArtefact } from './artefacts';

export type IntentExtractorMode = 'off' | 'shadow' | 'active' | 'strict';

export function getIntentExtractorMode(): IntentExtractorMode {
  const raw = (process.env.INTENT_EXTRACTOR_MODE || 'off').toLowerCase().trim();
  if (raw === 'shadow' || raw === 'active' || raw === 'strict') return raw;
  return 'off';
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
    return { ran: false, extraction: null, error: null };
  }

  let extraction: IntentExtractionResult;
  try {
    extraction = await extractCanonicalIntent(userMessage, conversationContext);
  } catch (err: any) {
    console.error(`[INTENT_EXTRACTOR_SHADOW] extraction failed: ${err.message}`);
    return { ran: true, extraction: null, error: err.message };
  }

  console.log(
    `[INTENT_EXTRACTOR_SHADOW] model=${extraction.model} valid=${extraction.validation.ok} duration=${extraction.duration_ms}ms` +
    (extraction.validation.errors.length > 0 ? ` errors=[${extraction.validation.errors.join('; ')}]` : '')
  );

  try {
    await createArtefact({
      runId,
      type: 'intent_extracted_shadow',
      title: 'Shadow Intent Extraction',
      summary: extraction.validation.ok
        ? `Extracted intent: ${extraction.validation.intent?.action ?? 'unknown'}`
        : `Validation failed: ${extraction.validation.errors.length} error(s)`,
      payload: {
        input_message: userMessage,
        extracted_intent: extraction.validation.ok ? extraction.validation.intent : null,
        validation_ok: extraction.validation.ok,
        validation_errors: extraction.validation.errors,
        model: extraction.model,
        duration_ms: extraction.duration_ms,
      },
      userId,
      conversationId,
    });
  } catch (err: any) {
    console.warn(`[INTENT_EXTRACTOR_SHADOW] artefact emit failed: ${err.message}`);
  }

  return { ran: true, extraction, error: null };
}
