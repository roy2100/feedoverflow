// Derive the favicon lookup domain from a feed URL.
// For `rsshub://<namespace>/...` feeds the real site has no hostname in the URL,
// so we approximate it as `<namespace>.com` (e.g. rsshub://bilibili/... → bilibili.com).
export function faviconDomain(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'rsshub:') return u.hostname ? `${u.hostname}.com` : '';
    return u.hostname;
  } catch {
    return '';
  }
}
