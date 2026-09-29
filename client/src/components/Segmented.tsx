// Small pill-style segmented control, shared by the list header toggles and the
// trend chart's range picker.
export default function Segmented<T extends string | number>({
  value,
  onSet,
  options,
}: {
  value: T;
  onSet: (value: T) => void;
  options: { value: T; label: string; title?: string }[];
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexShrink: 0,
        marginLeft: 8,
        gap: 2,
        padding: 2,
        borderRadius: 7,
        background: 'var(--bg-selected)',
      }}
    >
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={String(o.value)}
            onClick={() => onSet(o.value)}
            title={o.title}
            style={{
              fontSize: 11,
              fontWeight: 600,
              lineHeight: 1.4,
              padding: '2px 9px',
              borderRadius: 5,
              border: 'none',
              cursor: 'pointer',
              transition: 'color 0.15s, background 0.15s',
              background: active ? 'var(--bg)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-tertiary)',
              boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
