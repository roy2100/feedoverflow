import { X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { useStore } from '../store';
import type { TrendBucket, TrendDays } from '../types';
import Segmented from './Segmented';

// The 趋势 tab's chart: one bar per local day (articles mentioning the query), a
// trailing 7-day mean over it, and the list below narrowed to a day on click. It
// reads and drives the store directly, so desktop and mobile mount it the same way.
// Rationale: docs/plan-keyword-trend.md.

const PLOT_H = 96;
const PAD_TOP = 6;
const PAD_LEFT = 24; // room for the y labels
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// Round the y ceiling up to 1/2/5×10^k so the top gridline carries a plain number.
export function niceMax(n: number): number {
  if (n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

// Trailing 7-day mean, defined only where a full week of data exists and never
// for the last bucket: today is still in progress, and folding its partial count
// in would bend every curve down at the right edge.
export function movingAverage(counts: number[], window = 7): (number | null)[] {
  return counts.map((_, i) => {
    if (i < window - 1 || i === counts.length - 1) return null;
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += counts[j];
    return sum / window;
  });
}

function parseDay(date: string): { m: number; d: number; wd: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { m, d, wd: new Date(y, m - 1, d).getDay() };
}

function shortLabel(date: string): string {
  const { m, d } = parseDay(date);
  return `${m}/${d}`;
}

function longLabel(date: string): string {
  const { m, d, wd } = parseDay(date);
  return `${m}月${d}日 周${WEEKDAYS[wd]}`;
}

// A bar with only its data end rounded, anchored flat on the baseline.
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  const base = y + h;
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

export default function TrendChart() {
  const view = useStore((s) => s.selectedView);
  const trend = useStore((s) => s.trend);
  const setTrendDays = useStore((s) => s.setTrendDays);
  const setTrendDay = useStore((s) => s.setTrendDay);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const days: TrendDays = view.days ?? 30;
  const buckets: TrendBucket[] = trend?.buckets ?? [];
  const n = buckets.length;
  const counts = buckets.map((b) => b.count);
  const yMax = niceMax(Math.max(0, ...counts));
  const avg = days >= 30 ? movingAverage(counts) : [];
  const hasAvg = avg.some((v) => v !== null);

  const plotW = Math.max(0, width - PAD_LEFT);
  const slot = n ? plotW / n : 0;
  const gap = slot >= 6 ? 2 : 1;
  const barW = Math.max(1, slot - gap);
  const yOf = (v: number) => PAD_TOP + PLOT_H - (v / yMax) * PLOT_H;
  const xOf = (i: number) => PAD_LEFT + i * slot;

  const selectedIdx = view.day ? buckets.findIndex((b) => b.date === view.day) : -1;
  // The tooltip follows the pointer only; a selected day is already spelled out in
  // the chip under the chart, and a pinned tooltip would sit on top of the bars.
  const focusIdx = hover;
  const focus = focusIdx !== null ? buckets[focusIdx] : null;

  const indexAt = (clientX: number, svg: SVGSVGElement) => {
    const x = clientX - svg.getBoundingClientRect().left - PAD_LEFT;
    if (x < 0 || !slot) return null;
    return Math.min(n - 1, Math.floor(x / slot));
  };

  const avgPath = avg
    .map((v, i) => (v === null ? null : `${xOf(i) + slot / 2},${yOf(v)}`))
    .reduce<string>((d, p) => (p === null ? d : d + (d ? 'L' : 'M') + p), '');

  const tooltip = focus && focusIdx !== null && (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: Math.min(Math.max(0, xOf(focusIdx) + slot / 2 - 80), Math.max(0, width - 160)),
        width: 160,
        padding: '6px 8px',
        background: 'var(--bg-reader)',
        border: '1px solid var(--border-light)',
        borderRadius: 6,
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        fontSize: 11,
        lineHeight: 1.5,
        color: 'var(--text-secondary)',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
        {longLabel(focus.date)}
        {focusIdx === n - 1 && (
          <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}> · 进行中</span>
        )}
      </div>
      <div>
        {focus.count} 篇
        {focus.total > 0 && ` · 占当日 ${((focus.count / focus.total) * 100).toFixed(1)}%`}
      </div>
      {avg[focusIdx] != null && <div>7 日均值 {avg[focusIdx]!.toFixed(1)}</div>}
    </div>
  );

  return (
    <div
      style={{
        padding: '10px 16px 8px',
        borderBottom: '1px solid var(--border-light)',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          近 {days} 天{trend && ` · ${trend.matched} 篇`}
        </span>
        <Segmented<TrendDays>
          value={days}
          onSet={setTrendDays}
          options={[
            { value: 7, label: '7天' },
            { value: 30, label: '30天' },
            { value: 90, label: '90天' },
          ]}
        />
      </div>

      <div ref={wrapRef} style={{ position: 'relative', height: PAD_TOP + PLOT_H + 16 }}>
        {!trend ? (
          <div
            className="skeleton-bar"
            style={{ position: 'absolute', left: PAD_LEFT, right: 0, top: PAD_TOP, height: PLOT_H }}
          />
        ) : (
          width > 0 && (
            <svg
              width={width}
              height={PAD_TOP + PLOT_H + 16}
              role="img"
              aria-label={`${trend.query} 近 ${days} 天每日文章数，共 ${trend.matched} 篇`}
              style={{ display: 'block', touchAction: 'pan-y', cursor: 'pointer' }}
              onPointerMove={(e) => setHover(indexAt(e.clientX, e.currentTarget))}
              onPointerLeave={() => setHover(null)}
              onClick={(e) => {
                const i = indexAt(e.clientX, e.currentTarget);
                if (i === null) return;
                const date = buckets[i].date;
                setTrendDay(view.day === date ? null : date);
              }}
            >
              {/* Recessive grid: the baseline and the ceiling only. */}
              <line
                x1={PAD_LEFT}
                x2={width}
                y1={yOf(yMax)}
                y2={yOf(yMax)}
                stroke="var(--border-light)"
                strokeDasharray="2 3"
              />
              <line x1={PAD_LEFT} x2={width} y1={yOf(0)} y2={yOf(0)} stroke="var(--border)" />
              <text
                x={PAD_LEFT - 6}
                y={yOf(yMax) + 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--text-tertiary)"
              >
                {yMax}
              </text>
              <text
                x={PAD_LEFT - 6}
                y={yOf(0) + 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--text-tertiary)"
              >
                0
              </text>

              {buckets.map((b, i) => {
                if (!b.count) return null;
                const y = yOf(b.count);
                const dimmed = selectedIdx >= 0 && i !== selectedIdx;
                const strong = i === focusIdx || i === selectedIdx;
                const today = i === n - 1;
                return (
                  <path
                    key={b.date}
                    d={barPath(xOf(i) + gap / 2, y, barW, yOf(0) - y)}
                    fill={strong ? 'var(--accent)' : 'var(--accent-light)'}
                    fillOpacity={strong ? 1 : dimmed ? 0.18 : today ? 0.25 : 0.45}
                  />
                );
              })}

              {hasAvg && (
                <path
                  d={avgPath}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={selectedIdx >= 0 ? 0.35 : 1}
                  pointerEvents="none"
                />
              )}

              {n > 0 &&
                [0, Math.floor((n - 1) / 2), n - 1].map((i, k) => (
                  <text
                    key={i}
                    x={k === 0 ? PAD_LEFT : k === 2 ? width : xOf(i) + slot / 2}
                    y={PAD_TOP + PLOT_H + 13}
                    textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}
                    fontSize={10}
                    fill="var(--text-tertiary)"
                  >
                    {k === 2 ? '今天' : shortLabel(buckets[i].date)}
                  </text>
                ))}
            </svg>
          )
        )}
        {tooltip}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          minHeight: 20,
          marginTop: 2,
          fontSize: 11,
          color: 'var(--text-tertiary)',
        }}
      >
        {hasAvg && (
          <>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: 'var(--accent-light)',
                  opacity: 0.45,
                }}
              />
              每日篇数
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{ width: 12, height: 2, borderRadius: 1, background: 'var(--accent)' }}
              />
              7 日均值
            </span>
          </>
        )}
        {selectedIdx >= 0 && (
          <button
            onClick={() => setTrendDay(null)}
            title="显示全部日期"
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              fontSize: 11,
              color: 'var(--accent)',
              background: 'var(--bg-selected)',
              border: 'none',
              borderRadius: 5,
              padding: '2px 6px',
              cursor: 'pointer',
            }}
          >
            {longLabel(buckets[selectedIdx].date)} · {buckets[selectedIdx].count} 篇
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
