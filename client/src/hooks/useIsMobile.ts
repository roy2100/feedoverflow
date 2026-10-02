import { useState, useEffect } from 'react';

// The one breakpoint. Exported for the store, which must not ask for mobile-only
// payload (the card deck's summaries) on a desktop that happens to have it stored.
export function isMobileWidth(): boolean {
  return window.innerWidth <= 768;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(isMobileWidth);
  useEffect(() => {
    const handler = () => setIsMobile(isMobileWidth());
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
}
