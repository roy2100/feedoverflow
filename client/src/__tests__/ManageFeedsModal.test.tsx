import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import ManageFeedsModal from '../components/ManageFeedsModal';
import {
  currentSubscription,
  deviceCount,
  ensureSubscribed,
  pushBlocker,
  unsubscribeDevice,
} from '../lib/push';
import type { Feed } from '../types';

// jsdom has no Push API, so the real helpers all bail out early — which would
// make the toggle assertions below vacuous (onUpdate never reached).
vi.mock('../lib/push', () => ({
  ensureSubscribed: vi.fn().mockResolvedValue(undefined),
  unsubscribeDevice: vi.fn().mockResolvedValue(undefined),
  currentSubscription: vi.fn().mockResolvedValue(null),
  deviceCount: vi.fn().mockResolvedValue(1),
  pushBlocker: vi.fn().mockReturnValue(null),
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
  // The module mock's vi.fn()s live across tests; restoreAllMocks does not reset
  // their call history, so a later "was never called" assertion would see an
  // earlier test's call.
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(pushBlocker).mockReturnValue(null);
  vi.mocked(currentSubscription).mockResolvedValue(null);
  vi.mocked(deviceCount).mockResolvedValue(1);
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

describe('ManageFeedsModal device registration', () => {
  it('says this device is not receiving even when a feed is enabled', async () => {
    // The trap this row exists for: push_enabled is global, so a device that
    // never subscribed (another browser, or the same phone after reinstalling
    // the PWA) shows every bell as on and receives nothing.
    render(
      <ManageFeedsModal
        feeds={[{ id: '1', name: 'HN', url: 'https://hn.example/rss', push_enabled: true }]}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    // Names 更新推送 outright: inside a modal titled 管理订阅源, a bare "不接收"
    // reads as "not receiving articles".
    expect(
      await screen.findByText('本设备不接收更新推送 · 已开启的订阅源不会推送到这里'),
    ).toBeInTheDocument();
    expect(screen.getByText('在本设备接收')).toBeInTheDocument();
    expect(screen.getByTitle('关闭更新推送')).toBeInTheDocument();
  });

  it('registers this device without touching any feed', async () => {
    const onUpdate = vi.fn();
    render(
      <ManageFeedsModal feeds={feeds} onClose={vi.fn()} onDelete={vi.fn()} onUpdate={onUpdate} />,
    );
    // No feed is enabled here, so the "已开启的订阅源…" clause would be noise.
    await screen.findByText('本设备不接收更新推送');
    vi.mocked(currentSubscription).mockResolvedValue({ endpoint: 'x' } as PushSubscription);

    fireEvent.click(screen.getByText('在本设备接收'));

    expect(await screen.findByText('本设备正在接收更新推送')).toBeInTheDocument();
    expect(ensureSubscribed).toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('deregisters this device without disabling the feed for the others', async () => {
    vi.mocked(currentSubscription).mockResolvedValue({ endpoint: 'x' } as PushSubscription);
    vi.mocked(deviceCount).mockResolvedValue(2);
    const onUpdate = vi.fn();
    render(
      <ManageFeedsModal
        feeds={[{ id: '1', name: 'HN', url: 'https://hn.example/rss', push_enabled: true }]}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onUpdate={onUpdate}
      />,
    );
    expect(await screen.findByText('本设备正在接收更新推送 · 共 2 台设备')).toBeInTheDocument();
    vi.mocked(currentSubscription).mockResolvedValue(null);

    fireEvent.click(screen.getByText('不再接收'));

    expect(
      await screen.findByText('本设备不接收更新推送 · 已开启的订阅源不会推送到这里'),
    ).toBeInTheDocument();
    expect(unsubscribeDevice).toHaveBeenCalled();
    // The feed stays enabled: one device opting out must not silently cut off
    // every other device.
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('turning a feed off no longer deregisters the device', async () => {
    vi.mocked(currentSubscription).mockResolvedValue({ endpoint: 'x' } as PushSubscription);
    render(
      <ManageFeedsModal
        feeds={[{ id: '1', name: 'HN', url: 'https://hn.example/rss', push_enabled: true }]}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await screen.findByText(/本设备正在接收更新推送/);

    fireEvent.click(screen.getByTitle('关闭更新推送'));

    await waitFor(() => expect(screen.getByTitle('关闭更新推送')).toBeInTheDocument());
    expect(unsubscribeDevice).not.toHaveBeenCalled();
  });

  it('explains an iOS device that has not been installed to the home screen', async () => {
    vi.mocked(pushBlocker).mockReturnValue('needs-install');
    render(
      <ManageFeedsModal feeds={feeds} onClose={vi.fn()} onDelete={vi.fn()} onUpdate={vi.fn()} />,
    );

    expect(await screen.findByText('本设备需先添加到主屏幕，才能接收更新推送')).toBeInTheDocument();
    // No control to click: installing is a step only the user can take.
    expect(screen.queryByText('在本设备接收')).not.toBeInTheDocument();
  });
});
