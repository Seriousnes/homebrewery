import { describe, expect, it } from 'vitest';
import { localStatusInfo } from './localStatus';

const base = { lastSavedAt: null, error: null, persistent: true };

describe('localStatusInfo', () => {
  it('says where the brew is kept', () => {
    expect(localStatusInfo({ ...base, status: 'idle' }).label).toBe('Not saved yet');
    expect(localStatusInfo({ ...base, status: 'dirty' }).label).toBe('Unsaved changes');
    expect(localStatusInfo({ ...base, status: 'saving' })).toMatchObject({ label: 'Saving…', tone: 'busy' });
    const saved = localStatusInfo({ ...base, status: 'saved', lastSavedAt: Date.now() });
    expect(saved).toMatchObject({ label: 'Saved on this device', tone: 'neutral' });
    expect(saved.description).toContain('Only this browser has it');
  });

  it('warns when the browser keeps nothing, and reports a failed write', () => {
    expect(localStatusInfo({ ...base, status: 'saved', persistent: false })).toMatchObject({ label: 'Not kept', tone: 'warning' });
    const failed = localStatusInfo({ ...base, status: 'error', error: new Error('QuotaExceededError') });
    expect(failed).toMatchObject({ label: 'Couldn’t save', tone: 'error' });
    expect(failed.description).toContain('QuotaExceededError');
  });
});
