import { X, Check, Trash2, Pencil, Plus, Layers } from 'lucide-react';
import { useCallback, useState } from 'react';

import { useIsMobile } from '../hooks/useIsMobile';
import type { Collection, CollectionRule, Feed } from '../types';
import ModalOverlay from './ModalOverlay';

// A collection is the union of its rules, each `feed AND include AND NOT exclude`.
// The editor below is a direct rendering of that: one row per rule, three fields,
// no query syntax to learn. Rationale: docs/plan-collections.md.

const EMPTY_RULE: CollectionRule = { feedId: '', include: '', exclude: '' };

interface ManageCollectionsModalProps {
  collections: Collection[];
  feeds: Feed[];
  onClose: () => void;
  onCreate: (input: { name: string; rules: CollectionRule[] }) => Promise<void>;
  onUpdate: (id: string, patch: { name?: string; rules?: CollectionRule[] }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export default function ManageCollectionsModal({
  collections,
  feeds,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: ManageCollectionsModalProps) {
  // null = list view; '' = creating a new one; otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);

  const target = editing ? collections.find((c) => c.id === editing) : undefined;

  // Escape unwinds the sub-editor first; only the list view exits the modal.
  const onEscape = useCallback(() => {
    if (editing !== null) setEditing(null);
    else onClose();
  }, [editing, onClose]);

  return (
    <ModalOverlay onClose={onClose} onEscape={onEscape}>
      <div
        style={{
          background: 'var(--bg-reader)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: 'min(560px, calc(100vw - 32px))',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
          animation: 'modalSlideUp 0.18s cubic-bezier(0.34,1.2,0.64,1)',
        }}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-light)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
            {editing === null ? '管理合集' : editing === '' ? '新建合集' : '编辑合集'}
          </span>
          {editing === null && (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {collections.length} 个
            </span>
          )}
          <button
            onClick={onClose}
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
            }}
          >
            <X size={14} />
          </button>
        </div>

        {editing === null ? (
          <CollectionList
            collections={collections}
            feeds={feeds}
            onEdit={setEditing}
            onDelete={onDelete}
            onNew={() => setEditing('')}
          />
        ) : (
          <CollectionEditor
            key={editing}
            collection={target}
            feeds={feeds}
            onCancel={() => setEditing(null)}
            onSave={async (name, rules) => {
              if (target) await onUpdate(target.id, { name, rules });
              else await onCreate({ name, rules });
              setEditing(null);
            }}
          />
        )}
      </div>
    </ModalOverlay>
  );
}

// ruleSummary renders a rule as the sentence it means, so the list view explains a
// collection without opening it.
function ruleSummary(rule: CollectionRule, feeds: Feed[]): string {
  const feed = rule.feedId ? feeds.find((f) => f.id === rule.feedId) : undefined;
  // A rule can outlive the feed it names — deleting a feed leaves the rule alone
  // rather than silently rewriting what the user asked for.
  const source = rule.feedId ? (feed ? feed.name : '已删除的订阅源') : '全部订阅源';
  const parts = [source];
  if (rule.include) parts.push(`含「${rule.include}」`);
  if (rule.exclude) parts.push(`不含「${rule.exclude}」`);
  return parts.join(' · ');
}

interface CollectionListProps {
  collections: Collection[];
  feeds: Feed[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onNew: () => void;
}

function CollectionList({ collections, feeds, onEdit, onDelete, onNew }: CollectionListProps) {
  const isMobile = useIsMobile();
  return (
    <>
      <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0 4px' }}>
        {collections.length === 0 ? (
          <p
            style={{
              fontSize: 13,
              color: 'var(--text-tertiary)',
              textAlign: 'center',
              padding: '28px 24px',
              lineHeight: 1.7,
              margin: 0,
            }}
          >
            合集把多个订阅源合成一个文章流，
            <br />
            还可以按关键词只保留其中一类文章。
          </p>
        ) : (
          collections.map((c) => (
            <CollectionRow
              key={c.id}
              collection={c}
              feeds={feeds}
              isMobile={isMobile}
              onEdit={() => onEdit(c.id)}
              onDelete={() => onDelete(c.id)}
            />
          ))
        )}
      </div>
      <div style={{ padding: '10px 20px 14px', borderTop: '1px solid var(--border-light)' }}>
        <button
          onClick={onNew}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 12px',
            borderRadius: 7,
            fontSize: 13,
            fontWeight: 500,
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <Plus size={13} /> 新建合集
        </button>
      </div>
    </>
  );
}

interface CollectionRowProps {
  collection: Collection;
  feeds: Feed[];
  isMobile: boolean;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}

function CollectionRow({ collection, feeds, isMobile, onEdit, onDelete }: CollectionRowProps) {
  const [hovered, setHovered] = useState(false);
  // Two-step delete, same as ManageFeedsModal: the first click arms, the second
  // commits, and leaving the row disarms so nothing stays armed unattended.
  const [confirming, setConfirming] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setConfirming(false);
      }}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        padding: '8px 20px',
        gap: 10,
        background: hovered ? 'var(--bg-hover)' : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      <Layers size={13} style={{ color: '#3B9E6E', flexShrink: 0, marginTop: 3 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{collection.name}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
          {collection.rules.map((r, i) => (
            <div key={i}>{ruleSummary(r, feeds)}</div>
          ))}
        </div>
      </div>
      {(hovered || isMobile) && (
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <RowBtn onClick={onEdit} title="编辑" color="var(--text-tertiary)" isMobile={isMobile}>
            <Pencil size={11} />
          </RowBtn>
          <RowBtn
            onClick={() => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              setConfirming(false);
              void onDelete();
            }}
            title={confirming ? '再点一次确认删除' : '删除'}
            color={confirming ? 'var(--red)' : 'var(--text-tertiary)'}
            isMobile={isMobile}
            armed={confirming}
          >
            {confirming ? <Check size={11} /> : <Trash2 size={11} />}
          </RowBtn>
        </div>
      )}
    </div>
  );
}

interface CollectionEditorProps {
  collection?: Collection;
  feeds: Feed[];
  onCancel: () => void;
  onSave: (name: string, rules: CollectionRule[]) => Promise<void>;
}

function CollectionEditor({ collection, feeds, onCancel, onSave }: CollectionEditorProps) {
  const [name, setName] = useState(collection?.name ?? '');
  const [rules, setRules] = useState<CollectionRule[]>(
    collection?.rules.length ? collection.rules : [{ ...EMPTY_RULE }],
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const patchRule = (i: number, patch: Partial<CollectionRule>) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const handleSave = async () => {
    // Mirror the server's check locally so the failure is explained next to the
    // field that caused it, not as a bare error banner after a round trip.
    const trimmed = rules
      .map((r) => ({
        feedId: r.feedId.trim(),
        include: r.include.trim(),
        exclude: r.exclude.trim(),
      }))
      .filter((r) => r.feedId || r.include);
    if (!name.trim()) {
      setError('请填写合集名称');
      return;
    }
    if (trimmed.length === 0) {
      setError('每条规则至少要指定一个订阅源或关键词');
      return;
    }
    setError('');
    setSaving(true);
    try {
      await onSave(name.trim(), trimmed);
    } catch (e) {
      setError((e as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const fieldStyle: React.CSSProperties = {
    fontSize: 13,
    padding: '5px 8px',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    color: 'var(--text-primary)',
    outline: 'none',
    fontFamily: 'var(--font-ui)',
    minWidth: 0,
  };

  return (
    <>
      <div style={{ overflowY: 'auto', flex: 1, padding: '14px 20px' }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="合集名称"
          autoFocus
          style={{ ...fieldStyle, width: '100%', marginBottom: 14 }}
        />

        <p
          style={{
            fontSize: 11.5,
            color: 'var(--text-tertiary)',
            margin: '0 0 8px',
            lineHeight: 1.6,
          }}
        >
          合集包含所有满足<b>任意一条</b>规则的文章。关键词匹配标题和摘要；英文按整词匹配，
          「AI」不会命中「said」。
        </p>

        {rules.map((rule, i) => (
          <div
            key={i}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) auto',
              gap: 6,
              marginBottom: 6,
              alignItems: 'center',
            }}
          >
            <select
              value={rule.feedId}
              onChange={(e) => patchRule(i, { feedId: e.target.value })}
              style={fieldStyle}
            >
              <option value="">全部订阅源</option>
              {feeds.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <input
              value={rule.include}
              onChange={(e) => patchRule(i, { include: e.target.value })}
              placeholder="包含关键词"
              style={fieldStyle}
            />
            <input
              value={rule.exclude}
              onChange={(e) => patchRule(i, { exclude: e.target.value })}
              placeholder="排除关键词"
              style={fieldStyle}
            />
            <button
              onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
              disabled={rules.length === 1}
              title="删除这条规则"
              style={{
                width: 26,
                height: 26,
                borderRadius: 5,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'none',
                border: 'none',
                color: 'var(--text-tertiary)',
                cursor: rules.length === 1 ? 'default' : 'pointer',
                opacity: rules.length === 1 ? 0.3 : 1,
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}

        <button
          onClick={() => setRules((rs) => [...rs, { ...EMPTY_RULE }])}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            marginTop: 4,
            padding: '4px 0',
            fontSize: 12.5,
            color: 'var(--accent)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <Plus size={12} /> 添加规则
        </button>

        {error && <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--red)' }}>{error}</p>}
      </div>

      <div
        style={{
          padding: '10px 20px 14px',
          borderTop: '1px solid var(--border-light)',
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
        }}
      >
        <button
          onClick={onCancel}
          style={{
            padding: '7px 14px',
            borderRadius: 7,
            fontSize: 13,
            background: 'var(--bg-selected)',
            color: 'var(--text-secondary)',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          取消
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '7px 14px',
            borderRadius: 7,
            fontSize: 13,
            fontWeight: 500,
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          保存
        </button>
      </div>
    </>
  );
}

interface RowBtnProps {
  onClick: () => void;
  title: string;
  color: string;
  isMobile: boolean;
  armed?: boolean;
  children: React.ReactNode;
}

function RowBtn({ onClick, title, color, isMobile, armed, children }: RowBtnProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: isMobile ? 34 : 24,
        height: isMobile ? 34 : 24,
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color,
        background: armed ? 'var(--bg-selected)' : 'none',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
