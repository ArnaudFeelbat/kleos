import { describe, expect, it } from 'vitest';
import { Settings, compareVersions, defaultSettings } from './settings';

describe('compareVersions', () => {
  it('orders by number, not text', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.5.0', '0.5.1')).toBeLessThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
  });

  it('puts a pre-release before its release', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0);
  });

  it('sorts unparseable versions lowest', () => {
    expect(compareVersions('garbage', '0.0.1')).toBeLessThan(0);
    expect(compareVersions('0.0.1', 'garbage')).toBeGreaterThan(0);
  });
});

describe('Settings', () => {
  it('defaults to asking before any update check', () => {
    expect(defaultSettings).toEqual({
      appearance: 'system',
      pageSize: 200,
      queryTimeoutSeconds: 0,
      updateChecks: 'ask',
      skippedVersion: null,
    });
  });

  it('rejects page sizes and timeouts outside the offered choices', () => {
    expect(Settings.safeParse({ pageSize: 250 }).success).toBe(false);
    expect(Settings.safeParse({ queryTimeoutSeconds: 45 }).success).toBe(false);
  });
});
