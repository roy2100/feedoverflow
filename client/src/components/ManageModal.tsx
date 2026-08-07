import { X, ArrowLeft } from 'lucide-react';
import { useCallback, useState } from 'react';

import type { Collection, CollectionRule, Feed, FeedPatch } from '../types';
import AddFeedPanel from './AddFeedPanel';
import { CollectionList, CollectionEditor } from './CollectionsPanel';
import FeedsPanel from './FeedsPanel';
import ModalOverlay from './ModalOverlay';

// One modal for everything the sidebar lists: 订阅源 and 合集. They are two
// *things*, which is the only axis this tab bar carries — the add sub-view's own
// 手动/OPML strip is two *methods*, so it lives inside the sub-view and never
// beside these. Rationale: docs/plan-merge-manage-modals.md.
//
// 设置 deliberately stays out: it is configuration, not content, and it is opened
// once a month rather than weekly. It keeps the sidebar footer — and with it the
// gear icon, which now means exactly one thing in this app.

export type ManageTab = 'feeds' | 'collections';

/** The one-level-deep view a tab can push. `''` as a collection id means "new". */
type Sub = { kind: 'add-feed' } | { kind: 'collection'; id: string };

interface ManageModalProps {
  feeds: Feed[];
  collections: Collection[];
  initialTab?: ManageTab;
  /** Entry straight into a sub-view — the toolbar's + opens the add form directly. */
  initialSub?: 'add-feed';
  onClose: () => void;
  onAddFeed: (input: { url: string }) => Promise<void>;
  onImportFeeds: (newFeeds: Feed[]) => void;
  onDeleteFeed: (feedId: string) => Promise<void>;
  onUpdateFeed: (feedId: string, patch: FeedPatch) => Promise<void>;
  onCreateCollection: (input: { name: string; rules: CollectionRule[] }) => Promise<void>;
  onUpdateCollection: (
    id: string,
    patch: { name?: string; rules?: CollectionRule[] },
  ) => Promise<void>;
  onDeleteCollection: (id: string) => Promise<void>;
}

export default function ManageModal({
  feeds,
  collections,
  initialTab = 'feeds',
  initialSub,
  onClose,
  onAddFeed,
  onImportFeeds,
  onDeleteFeed,
  onUpdateFeed,
  onCreateCollection,
  onUpdateCollection,
  onDeleteCollection,
}: ManageModalProps) {
  const [tab, setTab] = useState<ManageTab>(initialTab);
  const [sub, setSub] = useState<Sub | null>(initialSub ? { kind: initialSub } : null);
  // True while the sub-view on screen is the one the modal *opened into*. Backing
  // out of that one closes the modal: the list behind it is not where the user
  // came from, and making a mis-clicked + take two Escapes to dismiss is worse
  // than skipping a list they never asked for.
  const [subIsEntry, setSubIsEntry] = useState(!!initialSub);

  const openSub = (next: Sub) => {
    setSub(next);
    setSubIsEntry(false);
  };

  const back = useCallback(() => {
    if (subIsEntry) onClose();
    else setSub(null);
  }, [subIsEntry, onClose]);

  // Escape unwinds a sub-view before the modal; the backdrop always closes outright.
  const onEscape = useCallback(() => {
    if (sub) back();
    else onClose();
  }, [sub, back, onClose]);

  const editing =
    sub?.kind === 'collection' && sub.id ? collections.find((c) => c.id === sub.id) : undefined;

  const subTitle =
    sub?.kind === 'add-feed'
      ? '添加订阅源'
      : sub?.kind === 'collection'
        ? sub.id
          ? '编辑合集'
          : '新建合集'
        : '';

  return (
    <ModalOverlay onClose={onClose} onEscape={onEscape}>
      <div
        style={{
          background: 'var(--bg-reader)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          // Fixed widths would overflow a phone; this modal is reachable on mobile
          // because it owns the per-feed notification toggle.
          width: 'min(560px, calc(100vw - 32px))',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
          animation: 'modalSlideUp 0.18s cubic-bezier(0.34,1.2,0.64,1)',
        }}
      >
        {/* Header — tabs at the root, a title with a way back inside a sub-view.
            Never both: the tab bar is what a sub-view replaces, which is also why
            an open editor cannot have its unsaved rules swapped out from under it. */}
        <div
          style={{
            padding: '13px 20px',
            borderBottom: '1px solid var(--border-light)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}
        >
          {sub ? (
            <>
              <button
                onClick={back}
                title={subIsEntry ? '关闭' : '返回'}
                aria-label={subIsEntry ? '关闭' : '返回'}
                style={{
                  width: 28,
                  height: 28,
                  marginLeft: -6,
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'none',
                  color: 'var(--text-secondary)',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'background 0.12s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                <ArrowLeft size={15} />
              </button>
              <span
                style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}
              >
                {subTitle}
              </span>
            </>
          ) : (
            <>
              <div
                style={{
                  display: 'flex',
                  gap: 2,
                  background: 'var(--bg-panel)',
                  borderRadius: 7,
                  padding: 3,
                  flexShrink: 0,
                }}
              >
                {(
                  [
                    ['feeds', '订阅源'],
                    ['collections', '合集'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    style={{
                      padding: '4px 14px',
                      borderRadius: 5,
                      fontSize: 12.5,
                      fontWeight: 500,
                      background: tab === key ? 'var(--bg-reader)' : 'transparent',
                      color: tab === key ? 'var(--text-primary)' : 'var(--text-tertiary)',
                      border: tab === key ? '1px solid var(--border)' : '1px solid transparent',
                      cursor: 'pointer',
                      boxShadow: tab === key ? '0 1px 3px rgba(0,0,0,0.07)' : 'none',
                      transition: 'all 0.15s',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-tertiary)' }}>
                {tab === 'feeds' ? feeds.length : collections.length} 个
              </span>
            </>
          )}
          <button
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: 'var(--bg-hover)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              border: 'none',
              flexShrink: 0,
              transition: 'background 0.12s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-selected)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
          >
            <X size={14} />
          </button>
        </div>

        {sub?.kind === 'add-feed' ? (
          <AddFeedPanel onAdd={onAddFeed} onImport={onImportFeeds} onDone={back} />
        ) : sub?.kind === 'collection' ? (
          <CollectionEditor
            key={sub.id}
            collection={editing}
            feeds={feeds}
            onCancel={back}
            onSave={async (name, rules) => {
              if (editing) await onUpdateCollection(editing.id, { name, rules });
              else await onCreateCollection({ name, rules });
              back();
            }}
          />
        ) : tab === 'feeds' ? (
          <FeedsPanel
            feeds={feeds}
            onDelete={onDeleteFeed}
            onUpdate={onUpdateFeed}
            onAdd={() => openSub({ kind: 'add-feed' })}
          />
        ) : (
          <CollectionList
            collections={collections}
            feeds={feeds}
            onEdit={(id) => openSub({ kind: 'collection', id })}
            onDelete={onDeleteCollection}
            onNew={() => openSub({ kind: 'collection', id: '' })}
          />
        )}
      </div>
    </ModalOverlay>
  );
}
