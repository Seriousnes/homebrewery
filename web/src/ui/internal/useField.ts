import { type ReactNode, useId } from 'react';

export interface FieldIds {
  controlId: string;
  labelId: string;
  hintId: string | undefined;
  errorId: string | undefined;
  /** aria-describedby for the control: the caller's ids, the hint, the error. */
  describedBy: string | undefined;
}

/** Ids and aria-describedby wiring for a labelled form control with optional hint and error. */
export function useField(id: string | undefined, hint: ReactNode, error: ReactNode, describedBy?: string): FieldIds {
  const generated = useId();
  const controlId = id ?? `${generated}-control`;
  const hintId = hint ? `${generated}-hint` : undefined;
  const errorId = error ? `${generated}-error` : undefined;
  const ids = [describedBy, hintId, errorId].filter(Boolean).join(' ');
  return { controlId, labelId: `${generated}-label`, hintId, errorId, describedBy: ids || undefined };
}
