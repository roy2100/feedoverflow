// Browser side of the Web Push feature: permission, subscription, and keeping the
// server's push_subscriptions table in sync with this device.
//
// Platform notes that drive the checks below:
//   - Safari on iOS only exposes PushManager when the PWA has been installed to
//     the home screen. In a normal Safari tab the API is simply absent, which is
//     why pushBlocker() distinguishes "this browser can't" from "install first".
//   - Notification.requestPermission() must be called from a user gesture (both
//     iOS and Safari on macOS enforce this), so ensureSubscribed() is only ever
//     called straight out of a click handler.

const API = '/api';

/** Why push can't be turned on here, or null when it can. */
export type PushBlocker = 'unsupported' | 'needs-install';

export function pushBlocker(): PushBlocker | null {
  const hasAPI =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (hasAPI) return null;
  // iOS exposes the standalone flag on navigator; a non-installed iOS Safari is
  // the one case where the API is missing but the user can do something about it.
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone =
    // navigator.standalone is the iOS-specific flag; matchMedia is the standard
    // one but is absent in some embedded webviews, so neither can be assumed.
    (navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true;
  return iOS && !standalone ? 'needs-install' : 'unsupported';
}

/** The active subscription for this device, or null if it isn't subscribed. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushBlocker()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/**
 * Ensure this device is registered to receive push. Idempotent: an existing
 * subscription is re-posted rather than replaced, so the server row stays fresh
 * (and is restored if the DB was rebuilt) without invalidating the endpoint.
 *
 * Throws with a user-facing message — callers surface it directly.
 */
export async function ensureSubscribed(): Promise<void> {
  const blocker = pushBlocker();
  if (blocker === 'needs-install') {
    throw new Error('请先将本站添加到主屏幕，再开启推送');
  }
  if (blocker) {
    throw new Error('当前浏览器不支持推送通知');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('通知权限被拒绝，请在系统设置中允许后重试');
  }

  const r = await fetch(`${API}/push/key`);
  if (!r.ok) throw new Error('无法获取推送密钥');
  const { publicKey } = (await r.json()) as { publicKey: string };
  if (!publicKey) throw new Error('无法获取推送密钥');

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      // Required by every implementation; a silent push is not permitted.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const post = await fetch(`${API}/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!post.ok) throw new Error('注册推送失败');
}

/**
 * Unregister this device. Called when the last push-enabled feed is switched off,
 * so a user who turns everything off stops being a live endpoint on the server.
 */
export async function unsubscribeDevice(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await fetch(`${API}/push/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/**
 * Decode a base64url VAPID key into the Uint8Array applicationServerKey expects.
 * PushManager.subscribe rejects the raw string, so this conversion is mandatory.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
