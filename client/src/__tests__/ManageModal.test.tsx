import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import ManageModal from '../components/ManageModal';
import type { Collection, Feed } from '../types';

// jsdom has no Push API; FeedsPanel's device row would otherwise sit in 'checking'
// and swallow the assertions that share its modal.
vi.mock('../lib/push', () => ({
  ensureSubscribed: vi.fn().mockResolvedValue(undefined),
  unsubscribeDevice: vi.fn().mockResolvedValue(undefined),
  currentSubscription: vi.fn().mockResolvedValue(null),
  deviceCount: vi.fn().mockResolvedValue(1),
  pushBlocker: vi.fn().mockReturnValue(null),
}));

const feeds = [{ id: '1', name: 'HN', url: 'https://hn.example/rss' } as Feed];
const collections: Collection[] = [
  { id: 'c1', name: '短讯', rules: [{ feedId: '1', include: '', exclude: '' }] },
];

const onClose = vi.fn();

function renderModal(props: Partial<Parameters<typeof ManageModal>[0]> = {}) {
  render(
    <ManageModal
      feeds={feeds}
      collections={collections}
      onClose={onClose}
      onAddFeed={vi.fn().mockResolvedValue(undefined)}
      onImportFeeds={vi.fn()}
      onDeleteFeed={vi.fn().mockResolvedValue(undefined)}
      onUpdateFeed={vi.fn().mockResolvedValue(undefined)}
      onCreateCollection={vi.fn().mockResolvedValue(undefined)}
      onUpdateCollection={vi.fn().mockResolvedValue(undefined)}
      onDeleteCollection={vi.fn().mockResolvedValue(undefined)}
      {...props}
    />,
  );
}

beforeEach(() => {
  onClose.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ManageModal tabs', () => {
  it('opens on the feeds tab and switches to collections', () => {
    renderModal();
    expect(screen.getByText('HN')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '合集' }));

    expect(screen.getByText('短讯')).toBeInTheDocument();
    // "HN" is still on screen — the collection's rule names that feed — so the
    // footer button is what actually says which tab is showing.
    expect(screen.getByRole('button', { name: /新建合集/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /添加订阅源/ })).not.toBeInTheDocument();
  });

  it('opens directly on the collections tab when asked', () => {
    renderModal({ initialTab: 'collections' });
    expect(screen.getByText('短讯')).toBeInTheDocument();
  });
});

describe('ManageModal sub-views', () => {
  it('hides the tab bar while a sub-view is open', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /添加订阅源/ }));

    expect(screen.getByText('添加订阅源')).toBeInTheDocument();
    // Switching tabs under an open editor would discard its unsaved rules; the
    // tab bar being gone is what makes that unreachable.
    expect(screen.queryByRole('button', { name: '合集' })).not.toBeInTheDocument();
  });

  it('Escape unwinds a sub-view reached from the list, not the modal', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /添加订阅源/ }));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '合集' })).toBeInTheDocument();
  });

  it('Escape closes the modal when it opened straight into the sub-view', () => {
    // The toolbar's + lands here. The list behind it is not where the user came
    // from, so backing out of it must not cost a second Escape.
    renderModal({ initialSub: 'add-feed' });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('Escape closes the modal from the list', () => {
    renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
