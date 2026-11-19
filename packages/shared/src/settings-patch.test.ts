import { describe, expect, it } from 'vitest';
import { defaultSettings } from './settings';
import { applySettingsPatch, readStoredSettings } from './settings-patch';

describe('readStoredSettings', () => {
  it('keeps the appearance of a 0.4 preferences file and defaults the rest', () => {
    expect(readStoredSettings({ appearance: 'dark' })).toEqual({ ...defaultSettings, appearance: 'dark' });
  });

  it('falls back field by field, keeping the readable values', () => {
    expect(readStoredSettings({ appearance: 'sepia', pageSize: 500, updateChecks: 'on' })).toEqual({
      ...defaultSettings,
      pageSize: 500,
      updateChecks: 'on',
    });
  });

  it('starts from the defaults when the file holds no object', () => {
    expect(readStoredSettings(null)).toEqual(defaultSettings);
    expect(readStoredSettings('dark')).toEqual(defaultSettings);
    expect(readStoredSettings([1, 2])).toEqual(defaultSettings);
  });
});

describe('applySettingsPatch', () => {
  const current = { ...defaultSettings, appearance: 'dark' as const };

  it('merges the patch over the current settings', () => {
    expect(applySettingsPatch(current, { pageSize: 1000, skippedVersion: '0.5.1' })).toEqual({
      ...current,
      pageSize: 1000,
      skippedVersion: '0.5.1',
    });
  });

  it('ignores undefined values and unknown keys', () => {
    expect(applySettingsPatch(current, { appearance: undefined, colour: 'red' })).toEqual(current);
  });

  it('rejects an invalid value or a patch that is not an object', () => {
    expect(() => applySettingsPatch(current, { pageSize: 250 })).toThrow(/pageSize/);
    expect(() => applySettingsPatch(current, { updateChecks: 'sometimes' })).toThrow(/updateChecks/);
    expect(() => applySettingsPatch(current, null)).toThrow();
    expect(() => applySettingsPatch(current, ['dark'])).toThrow();
  });
});
