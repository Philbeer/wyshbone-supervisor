import { describe, it, expect } from 'vitest';
import { inferCountryFromLocation } from './goal-to-constraints';

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
