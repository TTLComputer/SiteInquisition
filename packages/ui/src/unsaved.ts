import { useEffect, useId } from 'react';

/**
 * Editors with unsaved changes register here, so leaving the view (or the
 * sub-tab) they live in asks first instead of silently dropping the edits.
 */
const editors = new Map<string, string>();

/** Mark this editor as holding unsaved changes while `dirty` is true. */
export function useUnsaved(dirty: boolean, what: string): void {
  const id = useId();
  useEffect(() => {
    if (dirty) editors.set(id, what);
    else editors.delete(id);
    return () => void editors.delete(id);
  }, [id, dirty, what]);
}

/** True when there is nothing unsaved, or the user agreed to drop it. Clears the marks on agreement. */
export function confirmLeave(): boolean {
  if (!editors.size) return true;
  const names = [...new Set(editors.values())].join(', ');
  if (!window.confirm(`You have unsaved changes in ${names}. Leave without saving?`)) return false;
  editors.clear();
  return true;
}
