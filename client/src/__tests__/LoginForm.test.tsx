import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import LoginForm from '../components/LoginForm';

let mockFetch: ReturnType<typeof vi.fn>;
const onLogin = vi.fn();

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  onLogin.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fill(user: string, pass: string) {
  fireEvent.change(screen.getByPlaceholderText('用户名'), { target: { value: user } });
  fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: pass } });
}

describe('LoginForm', () => {
  it('disables the submit button until both fields are filled', () => {
    render(<LoginForm onLogin={onLogin} />);
    const btn = screen.getByRole('button', { name: '登录' });
    expect(btn).toBeDisabled();
    fill('user', '');
    expect(btn).toBeDisabled();
    fill('user', 'pass');
    expect(btn).toBeEnabled();
  });

  it('posts credentials to /api/login and calls onLogin on success', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    render(<LoginForm onLogin={onLogin} />);
    fill('alice', 'secret');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(onLogin).toHaveBeenCalled());
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ user: 'alice', pass: 'secret' }),
      }),
    );
  });

  it('shows the server error message and does not call onLogin on bad credentials', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Invalid login' }),
    });
    render(<LoginForm onLogin={onLogin} />);
    fill('alice', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('Invalid login')).toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('falls back to a default message when the error response has none', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    render(<LoginForm onLogin={onLogin} />);
    fill('alice', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('用户名或密码错误')).toBeInTheDocument();
  });

  it('shows a network-error message when the request rejects', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    render(<LoginForm onLogin={onLogin} />);
    fill('alice', 'secret');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('网络错误，请重试')).toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('shows a loading label and disables the button while the request is in flight', async () => {
    // Never-resolving fetch keeps the form in its loading state.
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<LoginForm onLogin={onLogin} />);
    fill('alice', 'secret');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    const btn = await screen.findByRole('button', { name: '登录中…' });
    expect(btn).toBeDisabled();
  });
});
