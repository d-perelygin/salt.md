import { useSyncExternalStore } from 'react';

let aiEnabledState = true;
const listeners = new Set<() => void>();

export function setAiEnabledState(v: boolean) {
  if (aiEnabledState === v) return;
  aiEnabledState = v;
  for (const l of listeners) l();
}

export function getAiEnabledState(): boolean {
  return aiEnabledState;
}

export function useAiEnabled(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => aiEnabledState,
  );
}
