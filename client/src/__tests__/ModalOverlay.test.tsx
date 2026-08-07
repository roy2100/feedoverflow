import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import ModalOverlay from '../components/ModalOverlay';

const onClose = vi.fn();
const onEscape = vi.fn();

beforeEach(() => {
  onClose.mockReset();
  onEscape.mockReset();
});

function renderOverlay(props: { onEscape?: () => void } = {}) {
  render(
    <ModalOverlay onClose={onClose} {...props}>
      <div data-testid="panel">
        <p data-testid="text">selectable body text</p>
      </div>
    </ModalOverlay>,
  );
  return {
    backdrop: screen.getByTestId('panel').parentElement as HTMLElement,
    panel: screen.getByTestId('panel'),
    text: screen.getByTestId('text'),
  };
}

describe('ModalOverlay', () => {
  it('closes when the backdrop owns both the press and the release', () => {
    const { backdrop } = renderOverlay();
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The regression: a drag-select started inside the panel and released on the
  // backdrop dispatches `click` at their nearest common ancestor — the backdrop —
  // so a target-only check would dismiss the modal mid-selection.
  it('stays open when a drag started inside the panel and ended on the backdrop', () => {
    const { backdrop, text } = renderOverlay();
    fireEvent.pointerDown(text);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open on clicks that never reach the backdrop', () => {
    const { panel } = renderOverlay();
    fireEvent.pointerDown(panel);
    fireEvent.click(panel);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    renderOverlay();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('routes Escape to onEscape when one is given', () => {
    renderOverlay({ onEscape });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
