import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureSubscribed,
  pushBlocker,
  unsubscribeDevice,
  urlBase64ToUint8Array,
} from '../lib/push';

/**
 * jsdom exposes neither PushManager nor a service worker, so each test installs
 * exactly the globals the code path under test reads, then removes them again.
 */
function installPushEnv(
  overrides: {
    permission?: NotificationPermission;
    existingSubscription?: unknown;
    subscribe?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const requestPermission = vi.fn().mockResolvedValue(overrides.permission ?? 'granted');
  const subscribe =
    overrides.subscribe ??
    vi.fn().mockResolvedValue({
      endpoint: 'https://push.example/abc',
      toJSON: () => ({
        endpoint: 'https://push.example/abc',
        keys: { p256dh: 'pk', auth: 'au' },
      }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    });
  const pushManager = {
    subscribe,
    getSubscription: vi.fn().mockResolvedValue(overrides.existingSubscription ?? null),
  };

  vi.stubGlobal('Notification', { requestPermission });
  vi.stubGlobal('PushManager', class {});
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }) },
  });
  return { requestPermission, subscribe, pushManager };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('urlBase64ToUint8Array', () => {
  it('decodes an unpadded base64url VAPID key', () => {
    // "hi" is 'aGk' in base64url — one padding char short, which atob rejects
    // outright. PushManager.subscribe only accepts the decoded bytes.
    expect(Array.from(urlBase64ToUint8Array('aGk'))).toEqual([104, 105]);
  });

  it('maps the url-safe alphabet back to standard base64', () => {
    // 0xFB 0xFF encodes as '+/8' in standard base64 and '-_8' in base64url; a
    // real P-256 key hits these bytes routinely.
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255]);
  });
});

describe('pushBlocker', () => {
  it('reports unsupported when the APIs are absent', () => {
    expect(pushBlocker()).toBe('unsupported');
  });

  it('tells an iOS user in a plain tab to install the PWA first', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari',
    );
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    // iOS hides PushManager entirely until the PWA is on the home screen, so
    // "unsupported" would be actively misleading here.
    expect(pushBlocker()).toBe('needs-install');
  });

  it('reports no blocker once the push APIs exist', () => {
    installPushEnv();
    expect(pushBlocker()).toBeNull();
  });
});

describe('ensureSubscribed', () => {
  it('subscribes and posts the subscription to the server', async () => {
    const { subscribe } = installPushEnv();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      if (url.endsWith('/push/key')) {
        return { ok: true, json: async () => ({ publicKey: 'aGk' }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await ensureSubscribed();

    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const posted = fetchMock.mock.calls.find(([url]) => url.endsWith('/push/subscribe'));
    expect(posted).toBeDefined();
    expect(JSON.parse(String(posted![1]!.body))).toEqual({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'pk', auth: 'au' },
    });
  });

  it('reuses an existing subscription instead of re-subscribing', async () => {
    const existing = {
      endpoint: 'https://push.example/old',
      toJSON: () => ({ endpoint: 'https://push.example/old', keys: { p256dh: 'p', auth: 'a' } }),
    };
    const { subscribe } = installPushEnv({ existingSubscription: existing });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ publicKey: 'aGk' }) }) as Response),
    );

    await ensureSubscribed();

    // Re-subscribing would mint a new endpoint and orphan the stored row.
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('surfaces a denied permission instead of subscribing', async () => {
    const { subscribe } = installPushEnv({ permission: 'denied' });
    await expect(ensureSubscribed()).rejects.toThrow('通知权限被拒绝，请在系统设置中允许后重试');
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('asks an iOS user to install the PWA before requesting permission', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari',
    );
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    await expect(ensureSubscribed()).rejects.toThrow('请先将本站添加到主屏幕，再开启推送');
  });
});

describe('unsubscribeDevice', () => {
  it('drops the endpoint server-side and locally', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    installPushEnv({
      existingSubscription: { endpoint: 'https://push.example/abc', unsubscribe },
    });
    const fetchMock = vi.fn(async (url: string) => {
      void url;
      return { ok: true, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await unsubscribeDevice();

    expect(fetchMock.mock.calls[0]![0]).toContain('/push/unsubscribe');
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('is a no-op when this device was never subscribed', async () => {
    installPushEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await unsubscribeDevice();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
