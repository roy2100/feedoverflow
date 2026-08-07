import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import AddFeedPanel from '../components/AddFeedPanel';

let mockFetch: ReturnType<typeof vi.fn>;
const onDone = vi.fn();
const onAdd = vi.fn();
const onImport = vi.fn();

// Route by URL: ManualTab fetches /api/settings on mount; OPML import POSTs elsewhere.
function routeFetch(routes: Record<string, unknown>) {
  return vi.fn((url: string) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(routes[url] ?? {}) }),
  );
}

beforeEach(() => {
  onDone.mockReset();
  onAdd.mockReset().mockResolvedValue(undefined);
  onImport.mockReset();
  mockFetch = routeFetch({ '/api/settings': {} });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The panel is a sub-view of ManageModal, which owns dismissal — see
// ManageModal.test.tsx for what 取消 and Escape resolve to from here.
function renderModal() {
  return render(<AddFeedPanel onDone={onDone} onAdd={onAdd} onImport={onImport} />);
}

describe('AddFeedPanel — manual tab', () => {
  it('leaves the panel when the cancel button is clicked', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('submits the trimmed URL and leaves on success', async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/feed\.xml/), {
      target: { value: '  https://example.com/rss  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith({ url: 'https://example.com/rss' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('shows the error and stays put when adding fails', async () => {
    onAdd.mockRejectedValue(new Error('feed not reachable'));
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/feed\.xml/), {
      target: { value: 'https://bad.example/rss' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    expect(await screen.findByText('feed not reachable')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('disables the add button when the URL is empty', () => {
    renderModal();
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();
  });
});

describe('AddFeedPanel — OPML tab', () => {
  function switchToOpml() {
    fireEvent.click(screen.getByRole('button', { name: '导入 OPML' }));
  }

  it('shows the dropzone after switching tabs', () => {
    renderModal();
    switchToOpml();
    expect(screen.getByText('拖拽 OPML 文件至此')).toBeInTheDocument();
  });

  it('posts the file contents and reports the import result', async () => {
    mockFetch = routeFetch({
      '/api/settings': {},
      '/api/feeds/import-opml': { imported: 2, skipped: 1, feeds: [{ id: '1' }, { id: '2' }] },
    });
    vi.stubGlobal('fetch', mockFetch);

    renderModal();
    switchToOpml();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['<opml></opml>'], 'feeds.opml', { type: 'text/x-opml' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText('导入完成')).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/feeds/import-opml',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(onImport).toHaveBeenCalledWith([{ id: '1' }, { id: '2' }]);
  });

  it('shows a failure state when the import endpoint errors', async () => {
    mockFetch = vi.fn((url: string) => {
      if (url === '/api/feeds/import-opml') {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'bad opml' }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', mockFetch);

    renderModal();
    switchToOpml();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['nope'], 'feeds.opml', { type: 'text/x-opml' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText('解析失败')).toBeInTheDocument();
    expect(await screen.findByText('bad opml')).toBeInTheDocument();
    expect(onImport).not.toHaveBeenCalled();
  });
});
