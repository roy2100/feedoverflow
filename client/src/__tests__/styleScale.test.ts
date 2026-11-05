// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import baseline from './style-colors.baseline.json';
import { auditStyles } from './styleAudit';

const sourceDir = fileURLToPath(new URL('../', import.meta.url));
function sourceFiles(dir: string): Record<string, string> {
  return Object.assign(
    {},
    ...readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === '__tests__') return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return [sourceFiles(path)];
      return /\.(?:[jt]sx?|css)$/.test(path) && !/\.(?:test|spec)\./.test(path)
        ? [{ [path]: readFileSync(path, 'utf8') }]
        : [];
    }),
  );
}

const tokens = `:root {
  --text-md: 13px; --radius-sm: 6px; --weight-medium: 500; --accent: #123456;
}`;
const audit = auditStyles(sourceFiles(sourceDir));

describe('the UI style scale', () => {
  it('uses defined size, radius and weight tokens, with only documented exceptions', () => {
    expect(audit.violations).toEqual([]);
  });

  it('does not introduce colors or increase their existing literal counts', () => {
    // When migrating a color to a token, lower/remove its baseline entry in the same change.
    // Never raise these ceilings to make a failure pass.
    const ceilings: Record<string, number> = baseline;
    const regressions = Object.entries(audit.colors).flatMap(([color, uses]) =>
      uses.length > (ceilings[color] ?? 0)
        ? [`${color}: ${uses.length} uses (baseline ${ceilings[color] ?? 0})\n${uses.join('\n')}`]
        : [],
    );
    expect(regressions).toEqual([]);
  });
});

describe('style audit coverage', () => {
  it('fails if a source cannot be loaded instead of silently skipping it', () => {
    expect(() =>
      auditStyles({ '/style-audit//Example.tsx': 'const style = { fontSize: 16 };' }),
    ).toThrow('TypeScript did not load');
  });

  it('finds literals in conditional branches, references, computed keys and style assignments', () => {
    const result = auditStyles({
      'tokens.css': tokens,
      'Example.tsx': `
        const size = 16;
        const shared = { fontSize: mobile ? size : 'var(--text-md)' };
        const ui = <div style={{ ...shared, ['borderRadius']: active ? 4 : 'var(--radius-sm)',
          fontWeight: ready ? 500 : 600 }} />;
        element.style.fontSize = '14px';
        const comparison = element.style.fontSize === '14px';
        const missing = { fontSize: 'var(--text-missing)' };
        function nested() {
          const size = 'var(--text-md)';
          return { fontSize: size };
        }
      `,
    });
    expect(result.violations.map((message) => message.split(' ').slice(1).join(' '))).toEqual([
      'fontSize: 16',
      'borderRadius: 4',
      'fontWeight: 500',
      'fontWeight: 600',
      'fontSize: 14px',
      'fontSize: var(--text-missing)',
    ]);
  });

  it('checks CSS files and embedded CSS, excluding tokens, font descriptors and prose em sizes', () => {
    const result = auditStyles({
      'tokens.css': `${tokens}
        @font-face { font-family: Demo; font-weight: 500; src: url('/font.woff2'); }
        .rss-article h2 { font-size: 1.2em; }
        .button { font-size: 14px; border-radius: 5px; color: #abcdef; }
      `,
      'Example.tsx':
        'style.textContent = `.button { font-weight: 600; background: rgb(1, 2, 3); }`;',
    });
    expect(result.violations).toHaveLength(3);
    expect(Object.keys(result.colors)).toEqual(['#abcdef', 'rgb(1,2,3)']);
  });

  it('counts colors in branches, SVG attributes, gradients and shadows, ignoring comments', () => {
    const result = auditStyles({
      'Example.tsx': `
        // color: '#ffffff' must not count.
        const ui = <svg fill={active ? '#ABC' : '#abc'} stroke="white" style={{
          color: active ? 'red' : 'var(--red)',
          background: 'linear-gradient(#123456, #654321)',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.08)',
        }} />;
        const tinted = { background: \`rgb(1, 2, \${alpha})\` };
        const label = \`red \${count}\`;
        element.style.color = 'black';
      `,
    });
    expect(
      Object.fromEntries(
        Object.entries(result.colors).map(([color, uses]) => [color, uses.length]),
      ),
    ).toEqual({
      '#abc': 2,
      white: 1,
      red: 1,
      '#123456': 1,
      '#654321': 1,
      'rgba(0,0,0,0.08)': 1,
      'rgb(1,2,${alpha})': 1,
      black: 1,
    });
  });

  it('keeps exceptions narrow and rejects unrelated styles in the same component', () => {
    const result = auditStyles({
      'tokens.css': tokens,
      'components/ArticleReader.tsx': `
        const title = <h1 style={{ fontSize: 'clamp(22px, 3vw, 28px)' }} />;
        const other = <div style={{ fontSize: 'clamp(22px, 3vw, 28px)' }} />;
      `,
      'components/TrendChart.tsx': `
        const mark = { width: 8, height: 8, borderRadius: 2 };
        const other = { borderRadius: 2 };
        const axis = <text fontSize={10} />;
        const button = <button fontSize={10} />;
        const circle = { borderRadius: '50%' };
      `,
    });
    expect(result.violations).toHaveLength(3);
  });
});
