import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import SettingsModal from '../components/SettingsModal';

/** Stubs the two GETs the modal issues, and records every PATCH body. */
function stubFetch(keySet: boolean) {
  const patches: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    if (opts?.method === 'PATCH') {
      patches.push(JSON.parse(String(opts.body)));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (opts?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) };
    if (url === '/api/llm/config') {
      return {
        ok: true,
        json: async () => ({
          base_url: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          key_set: keySet,
          enabled: keySet,
        }),
      };
    }
    return { ok: true, json: async () => ({ rsshub_base_url: 'http://localhost:1200' }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return patches;
}

function llmPatches(patches: Record<string, unknown>[]) {
  return patches.filter((p) => 'model' in p || 'api_key' in p || 'base_url' in p);
}

/** Both sections have a 保存; the translation one is the second in DOM order. */
function saveLLM() {
  fireEvent.click(screen.getAllByText('保存')[1]);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('SettingsModal translation service', () => {
  // The first key ever entered is typed into a field that has no 更改 button,
  // because there is nothing stored to hide. Gating the send on "user clicked
  // 更改" silently dropped it, leaving key_set false and 测试连接 greyed forever.
  it('sends the first API key even though 更改 was never clicked', async () => {
    const patches = stubFetch(false);
    render(<SettingsModal onClose={vi.fn()} />);

    const input = await screen.findByPlaceholderText('sk-…');
    fireEvent.change(input, { target: { value: 'sk-first-key' } });
    saveLLM();

    await waitFor(() => expect(llmPatches(patches)).toHaveLength(1));
    expect(llmPatches(patches)[0]).toMatchObject({ api_key: 'sk-first-key' });
  });

  it('enables 测试连接 once the key is saved', async () => {
    stubFetch(false);
    render(<SettingsModal onClose={vi.fn()} />);

    const input = await screen.findByPlaceholderText('sk-…');
    expect(screen.getByText('测试连接')).toBeDisabled();

    fireEvent.change(input, { target: { value: 'sk-first-key' } });
    saveLLM();

    await waitFor(() => expect(screen.getByText('测试连接')).not.toBeDisabled());
  });

  // The browser never receives the stored key, so it has nothing to echo back —
  // a model-only edit must omit api_key rather than send an empty string.
  it('omits api_key when a key is stored and the field was not opened', async () => {
    const patches = stubFetch(true);
    render(<SettingsModal onClose={vi.fn()} />);

    const model = await screen.findByPlaceholderText('deepseek-chat');
    fireEvent.change(model, { target: { value: 'kimi-k2' } });
    saveLLM();

    await waitFor(() => expect(llmPatches(patches)).toHaveLength(1));
    expect(llmPatches(patches)[0]).not.toHaveProperty('api_key');
    expect(llmPatches(patches)[0]).toMatchObject({ model: 'kimi-k2' });
  });

  it('sends the key again after 更改 is clicked', async () => {
    const patches = stubFetch(true);
    render(<SettingsModal onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText('更改'));
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-second' } });
    saveLLM();

    await waitFor(() => expect(llmPatches(patches)).toHaveLength(1));
    expect(llmPatches(patches)[0]).toMatchObject({ api_key: 'sk-second' });
  });

  // 测试连接 reads what is stored, so testing a dirty form would report on the
  // wrong config.
  it('disables 测试连接 while there are unsaved edits', async () => {
    stubFetch(true);
    render(<SettingsModal onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('测试连接')).not.toBeDisabled());
    fireEvent.change(screen.getByPlaceholderText('deepseek-chat'), {
      target: { value: 'kimi-k2' },
    });
    expect(screen.getByText('测试连接')).toBeDisabled();
  });
});

describe('SettingsModal translation switch', () => {
  // The key is a capability, the switch is an intent. Without a key the checkbox
  // would flip a flag and nothing would ever be translated, so it says why instead.
  it('disables the switch until a key is stored', async () => {
    stubFetch(false);
    render(<SettingsModal onClose={vi.fn()} />);

    const box = await screen.findByLabelText('翻译文章标题');
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
  });

  it('reflects the stored switch state', async () => {
    stubFetch(true);
    render(<SettingsModal onClose={vi.fn()} />);

    const box = await screen.findByLabelText('翻译文章标题');
    expect(box).not.toBeDisabled();
    expect(box).toBeChecked();
  });

  // Sent on every save so the server sees the intended state; the server is what
  // decides whether that counts as an off→on transition worth re-stamping.
  it('sends the switch state with the save', async () => {
    const patches = stubFetch(true);
    render(<SettingsModal onClose={vi.fn()} />);

    fireEvent.click(await screen.findByLabelText('翻译文章标题'));
    saveLLM();

    await waitFor(() => expect(llmPatches(patches)).toHaveLength(1));
    expect(llmPatches(patches)[0]).toMatchObject({ enabled: false });
  });
});
