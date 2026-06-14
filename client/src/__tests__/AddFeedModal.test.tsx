import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import AddFeedModal from '../components/AddFeedModal';

let mockFetch: ReturnType<typeof vi.fn>;
const onClose = vi.fn();
const onAdd = vi.fn();
const onImport = vi.fn();

// Route by URL: ManualTab fetches /api/settings on mount; OPML import POSTs elsewhere.
function routeFetch(routes: Record<string, unknown>) {
  return vi.fn((url: string) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(routes[url] ?? {}) }),
  );
}

beforeEach(() => {
  onClose.mockReset();
  onAdd.mockReset().mockResolvedValue(undefined);
  onImport.mockReset();
  mockFetch = routeFetch({ '/api/settings': {} });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderModal() {
  return render(<AddFeedModal onClose={onClose} onAdd={onAdd} onImport={onImport} />);
}

describe('AddFeedModal — dismissal', () => {
  it('closes on Escape', () => {
    renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the cancel button is clicked', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('AddFeedModal — manual tab', () => {
  it('submits the trimmed URL and closes on success', async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/feed\.xml/), {
      target: { value: '  https://example.com/rss  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith({ url: 'https://example.com/rss' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows the error and stays open when adding fails', async () => {
    onAdd.mockRejectedValue(new Error('feed not reachable'));
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/feed\.xml/), {
      target: { value: 'https://bad.example/rss' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    expect(await screen.findByText('feed not reachable')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables the add button when the URL is empty', () => {
    renderModal();
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();
  });
});

describe('AddFeedModal — OPML tab', () => {
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

    // The modal portals to document.body, so query the document, not the render container.
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
