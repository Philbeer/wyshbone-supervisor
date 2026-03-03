import { describe, it, expect } from 'vitest';
import { inferCountryFromLocation, sanitiseLocationString, detectExactnessMode, detectDoNotStop } from './goal-to-constraints';

describe('inferCountryFromLocation', () => {
  it('returns US for "Texas"', () => {
    expect(inferCountryFromLocation('Texas')).toBe('US');
  });

  it('returns US for "texas" (case-insensitive)', () => {
    expect(inferCountryFromLocation('texas')).toBe('US');
  });

  it('returns US for "California"', () => {
    expect(inferCountryFromLocation('California')).toBe('US');
  });

  it('returns US for "New York"', () => {
    expect(inferCountryFromLocation('New York')).toBe('US');
  });

  it('returns US for "Florida"', () => {
    expect(inferCountryFromLocation('Florida')).toBe('US');
  });

  it('returns UK for "Sussex"', () => {
    expect(inferCountryFromLocation('Sussex')).toBe('UK');
  });

  it('returns UK for "London"', () => {
    expect(inferCountryFromLocation('London')).toBe('UK');
  });

  it('returns UK for "Kent"', () => {
    expect(inferCountryFromLocation('Kent')).toBe('UK');
  });

  it('returns UK for unknown location (defaults)', () => {
    expect(inferCountryFromLocation('Zurich')).toBe('UK');
  });

  it('returns US for "United States"', () => {
    expect(inferCountryFromLocation('United States')).toBe('US');
  });

  it('returns US for "USA"', () => {
    expect(inferCountryFromLocation('USA')).toBe('US');
  });
});

describe('sanitiseLocationString', () => {
  it('strips "and return exactly N results" from location', () => {
    expect(sanitiseLocationString('Arundel and return exactly 20 results')).toBe('Arundel');
  });

  it('strips "and return exactly N" without "results"', () => {
    expect(sanitiseLocationString('Arundel and return exactly 20')).toBe('Arundel');
  });

  it('strips "If fewer than N are found" clause', () => {
    expect(sanitiseLocationString('Arundel. If fewer than 20 are found, do not stop.')).toBe('Arundel');
  });

  it('strips "do not stop" from end', () => {
    expect(sanitiseLocationString('Arundel, do not stop')).toBe('Arundel');
  });

  it('leaves clean location unchanged', () => {
    expect(sanitiseLocationString('Arundel')).toBe('Arundel');
  });

  it('leaves multi-word location unchanged', () => {
    expect(sanitiseLocationString('East Sussex')).toBe('East Sussex');
  });

  it('handles complex contaminated string', () => {
    expect(sanitiseLocationString('Arundel and return exactly 20 results. If fewer than 20 are found, do not stop.')).toBe('Arundel');
  });

  it('strips trailing punctuation', () => {
    expect(sanitiseLocationString('Arundel.')).toBe('Arundel');
  });

  it('preserves comma-separated location parts', () => {
    expect(sanitiseLocationString('Brighton, East Sussex')).toBe('Brighton, East Sussex');
  });
});

describe('detectExactnessMode', () => {
  it('returns soft for normal "return exactly N" phrasing', () => {
    expect(detectExactnessMode('Find 20 pubs in Arundel and return exactly 20 results')).toBe('soft');
  });

  it('returns hard when user says "return none if you cannot return exactly"', () => {
    expect(detectExactnessMode('Find 20 pubs in Arundel. Return none if you cannot return exactly 20.')).toBe('hard');
  });

  it('returns hard for "must be exactly N"', () => {
    expect(detectExactnessMode('Find pubs in Arundel. Must be exactly 20 results.')).toBe('hard');
  });

  it('returns soft for plain goal without exactness language', () => {
    expect(detectExactnessMode('Find pubs in Arundel')).toBe('soft');
  });
});

describe('detectDoNotStop', () => {
  it('detects "do not stop" in goal', () => {
    expect(detectDoNotStop('Find 20 pubs in Arundel. If fewer than 20 are found, do not stop.')).toBe(true);
  });

  it('returns false when no "do not stop" present', () => {
    expect(detectDoNotStop('Find 20 pubs in Arundel')).toBe(false);
  });
});
