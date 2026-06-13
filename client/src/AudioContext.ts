import { createContext, useContext } from 'react';

import type { AudioCtxValue } from './types';

export const AudioContext = createContext<AudioCtxValue | null>(null);

export function useAudio(): AudioCtxValue {
  const ctx = useContext(AudioContext);
  if (!ctx) throw new Error('useAudio must be used within an AudioContext.Provider');
  return ctx;
}
