import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { isProbeEnabled, getIntentExtractorMode } from './intent-shadow';

describe('intent-shadow probe flag', () => {
  const saved = process.env.INTENT_EXTRACTOR_PROBE;

  it('isProbeEnabled returns false when INTENT_EXTRACTOR_PROBE is unset', () => {
    delete process.env.INTENT_EXTRACTOR_PROBE;
    assert.equal(isProbeEnabled(), false);
    process.env.INTENT_EXTRACTOR_PROBE = saved;
  });

  it('isProbeEnabled returns false when INTENT_EXTRACTOR_PROBE is empty string', () => {
    process.env.INTENT_EXTRACTOR_PROBE = '';
    assert.equal(isProbeEnabled(), false);
    process.env.INTENT_EXTRACTOR_PROBE = saved;
  });

  it('isProbeEnabled returns false when INTENT_EXTRACTOR_PROBE is "false"', () => {
    process.env.INTENT_EXTRACTOR_PROBE = 'false';
    assert.equal(isProbeEnabled(), false);
    process.env.INTENT_EXTRACTOR_PROBE = saved;
  });

  it('isProbeEnabled returns false when INTENT_EXTRACTOR_PROBE is "0"', () => {
    process.env.INTENT_EXTRACTOR_PROBE = '0';
    assert.equal(isProbeEnabled(), false);
    process.env.INTENT_EXTRACTOR_PROBE = saved;
  });

  it('isProbeEnabled returns true when INTENT_EXTRACTOR_PROBE is "true"', () => {
    process.env.INTENT_EXTRACTOR_PROBE = 'true';
    assert.equal(isProbeEnabled(), true);
    process.env.INTENT_EXTRACTOR_PROBE = saved;
  });

  it('isProbeEnabled returns true when INTENT_EXTRACTOR_PROBE is "TRUE"', () => {
    process.env.INTENT_EXTRACTOR_PROBE = 'TRUE';
    assert.equal(isProbeEnabled(), true);
    process.env.INTENT_EXTRACTOR_PROBE = saved;
  });

  it('isProbeEnabled returns true when INTENT_EXTRACTOR_PROBE is " true "', () => {
    process.env.INTENT_EXTRACTOR_PROBE = ' true ';
    assert.equal(isProbeEnabled(), true);
    process.env.INTENT_EXTRACTOR_PROBE = saved;
  });

  it('getIntentExtractorMode returns shadow when set', () => {
    const savedMode = process.env.INTENT_EXTRACTOR_MODE;
    process.env.INTENT_EXTRACTOR_MODE = 'shadow';
    assert.equal(getIntentExtractorMode(), 'shadow');
    process.env.INTENT_EXTRACTOR_MODE = savedMode;
  });

  it('getIntentExtractorMode returns off by default', () => {
    const savedMode = process.env.INTENT_EXTRACTOR_MODE;
    delete process.env.INTENT_EXTRACTOR_MODE;
    assert.equal(getIntentExtractorMode(), 'off');
    process.env.INTENT_EXTRACTOR_MODE = savedMode;
  });
});
