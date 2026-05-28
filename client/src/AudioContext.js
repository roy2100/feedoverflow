import { createContext, useContext } from 'react';

export const AudioContext = createContext(null);
export const useAudio = () => useContext(AudioContext);
