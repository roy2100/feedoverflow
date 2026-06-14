import { describe, it, expect } from 'vitest';

import { faviconDomain } from '../faviconDomain';

describe('faviconDomain', () => {
  it('returns the hostname for a normal https URL', () => {
    expect(faviconDomain('https://example.com/feed.xml')).toBe('example.com');
  });

  it('preserves subdomains', () => {
    expect(faviconDomain('https://news.ycombinator.com/rss')).toBe('news.ycombinator.com');
  });

  it('maps rsshub://<namespace>/... to <namespace>.com', () => {
    expect(faviconDomain('rsshub://bilibili/user/video/123')).toBe('bilibili.com');
  });

  it('returns empty string for an rsshub URL with no hostname', () => {
    expect(faviconDomain('rsshub:///some/path')).toBe('');
  });

  it('returns empty string for an unparseable URL', () => {
    expect(faviconDomain('not a url')).toBe('');
  });

  it('returns empty string for an empty input', () => {
    expect(faviconDomain('')).toBe('');
  });
});
