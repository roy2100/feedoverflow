import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import ManageFeedsModal from '../components/ManageFeedsModal';
import { ensureSubscribed } from '../lib/push';
import type { Feed } from '../types';

// jsdom has no Push API, so the real ensureSubscribed always rejects — which
// would make the toggle assertions below vacuous (onUpdate never reached).
vi.mock('../lib/push', () => ({
  ensureSubscribed: vi.fn().mockResolvedValue(undefined),
  unsubscribeDevice: vi.fn().mockResolvedValue(undefined),
}));

const feeds = [{ id: '1', name: 'HN', url: 'https://hn.example/rss' } as Feed];

function renderModal(overrides: Partial<Parameters<typeof ManageFeedsModal>[0]> = {}) {
  const onDelete = vi.fn().mockResolvedValue(undefined);
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  render(
    <ManageFeedsModal
      feeds={feeds}
      onClose={vi.fn()}
      onDelete={onDelete}
      onUpdate={onUpdate}
      {...overrides}
    />,
  );
  // Desktop rows reveal their actions on hover.
  fireEvent.mouseEnter(screen.getByText('HN').closest('div')!);
  return { onDelete, onUpdate };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ManageFeedsModal delete confirmation', () => {
  it('does not delete on the first click', () => {
    const { onDelete } = renderModal();

    fireEvent.click(screen.getByTitle('删除'));

    // Deleting a feed purges its non-starred articles; one misclick between the
    // adjacent 编辑 and 删除 icons must not be able to do that.
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByTitle('再点一次确认删除')).toBeInTheDocument();
  });

  it('deletes on the second click', () => {
    const { onDelete } = renderModal();

    fireEvent.click(screen.getByTitle('删除'));
    fireEvent.click(screen.getByTitle('再点一次确认删除'));

    expect(onDelete).toHaveBeenCalledWith('1');
  });

  it('disarms after 3s so a row is never left armed', async () => {
    const { onDelete } = renderModal();
    fireEvent.click(screen.getByTitle('删除'));

    vi.advanceTimersByTime(3000);

    await waitFor(() => expect(screen.getByTitle('删除')).toBeInTheDocument());
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('disarms when the pointer leaves the row', async () => {
    const { onDelete } = renderModal();
    const row = screen.getByText('HN').closest('div')!;
    fireEvent.click(screen.getByTitle('删除'));

    fireEvent.mouseLeave(row);
    fireEvent.mouseEnter(row);

    await waitFor(() => expect(screen.getByTitle('删除')).toBeInTheDocument());
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('ManageFeedsModal push toggle', () => {
  it('registers the device, then sends push_enabled alone', async () => {
    const { onUpdate } = renderModal();

    fireEvent.click(screen.getByTitle('开启更新推送'));

    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    // Exactly push_enabled: a rename must never ride along, or the server would
    // apply both and the two fields could not be toggled independently.
    expect(onUpdate).toHaveBeenCalledWith('1', { push_enabled: true });
    expect(ensureSubscribed).toHaveBeenCalled();
  });

  it('surfaces a subscribe failure in the row instead of flipping the toggle', async () => {
    vi.mocked(ensureSubscribed).mockRejectedValueOnce(
      new Error('请先将本站添加到主屏幕，再开启推送'),
    );
    const { onUpdate } = renderModal();

    fireEvent.click(screen.getByTitle('开启更新推送'));

    await waitFor(() =>
      expect(screen.getByText('请先将本站添加到主屏幕，再开启推送')).toBeInTheDocument(),
    );
    // The feed must not be marked as pushing when this device never registered.
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('shows an enabled feed as on without hovering', () => {
    render(
      <ManageFeedsModal
        feeds={[{ id: '1', name: 'HN', url: 'https://hn.example/rss', push_enabled: true }]}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    // Which feeds notify must be answerable by scanning the list, not by
    // hovering 53 rows one at a time.
    expect(screen.getByTitle('关闭更新推送')).toBeInTheDocument();
  });
});
