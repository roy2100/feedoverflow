import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ModalOverlayProps {
  /** Backdrop press-and-release, and Escape unless `onEscape` overrides it. */
  onClose: () => void;
  /** For modals whose Escape unwinds an inner step first (a sub-editor, say). */
  onEscape?: () => void;
  children: ReactNode;
}

// The backdrop dismiss deliberately tracks the *press*, not just the click.
// A `click` targets the nearest common ancestor of where the pointer went down
// and where it came up, so drag-selecting text from inside the panel out onto
// the backdrop reports the backdrop itself as the target — an `e.target ===
// e.currentTarget` check alone then closes the modal mid-selection. Requiring
// the backdrop to own the press too makes that impossible, and costs one ref.
export default function ModalOverlay({ onClose, onEscape, children }: ModalOverlayProps) {
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const dismiss = onEscape ?? onClose;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, onEscape]);

  return createPortal(
    <div
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedBackdrop.current) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(20,18,16,0.45)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        animation: 'fadeInOverlay 0.15s ease',
      }}
    >
      {children}

      <style>{`
        @keyframes fadeInOverlay { from{opacity:0} to{opacity:1} }
        @keyframes modalSlideUp { from{opacity:0;transform:translateY(12px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
      `}</style>
    </div>,
    document.body,
  );
}
