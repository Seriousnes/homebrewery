// Wording of a local brew's save status (LocalSaveStatus.tsx, the toolbar; issue #4).
import type { IconName } from '@/ui';
import { formatSavedAt, type StatusTone } from '../save/statusText';
import type { LocalSaveState } from './useLocalSave';

export interface LocalStatusInfo {
  label: string;
  description: string;
  icon: IconName;
  tone: StatusTone;
}

const NOT_KEPT = 'This browser doesn’t let the site keep data (private window or blocked site data): the brew is lost when this page closes. Download a PDF, or sign in and upload it.';

export function localStatusInfo(state: Pick<LocalSaveState, 'status' | 'lastSavedAt' | 'error' | 'persistent'>, now: number = Date.now()): LocalStatusInfo {
  if (!state.persistent && state.status !== 'error') {
    return { label: 'Not kept', description: NOT_KEPT, icon: 'warning', tone: 'warning' };
  }
  switch (state.status) {
    case 'idle':
      return { label: 'Not saved yet', description: 'This brew is saved on this device once you start writing.', icon: 'unsaved', tone: 'neutral' };
    case 'dirty':
      return { label: 'Unsaved changes', description: 'Changes are saved on this device a moment after you stop typing.', icon: 'unsaved', tone: 'neutral' };
    case 'saving':
      return { label: 'Saving…', description: 'Saving on this device.', icon: 'saving', tone: 'busy' };
    case 'saved':
      return {
        label: 'Saved on this device',
        description: `${state.lastSavedAt ? `All changes saved in this browser (${formatSavedAt(state.lastSavedAt, now)}).` : 'All changes saved in this browser.'} Only this browser has it until it is uploaded to an account.`,
        icon: 'saved',
        tone: 'neutral',
      };
    case 'error':
      return {
        label: 'Couldn’t save',
        description: `This browser refused to store the brew (${state.error instanceof Error ? state.error.message : 'storage error'}). It may be out of space. Your changes are still in this page.`,
        icon: 'saveError',
        tone: 'error',
      };
  }
}
