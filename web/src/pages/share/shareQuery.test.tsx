// Every GET /api/brews/share/{id} counts a view for readers: a page that mounts twice (React
// StrictMode, a quick remount) must reuse the request instead of cancelling it and asking again.
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrewForShare, useBrewForShare } from '@/api';
import { jsonResponse, mockApi } from '@/api/testing';
import { testQueryClient } from '@/app/testing';

const brew: BrewForShare = {
  shareId: 'share1',
  editId: null,
  docSchemaVersion: 1,
  doc: { type: 'doc', content: [] },
  style: '',
  meta: { title: 'Shared', description: '', tags: [], lang: 'en', theme: '5ePHB', published: true, thumbnailUrl: null },
  authors: ['alice'],
  pageCount: 1,
  views: 1,
  createdAt: '',
  updatedAt: '',
};

function Probe() {
  const query = useBrewForShare('share1');
  return <p>{query.data ? query.data.meta.title : 'loading'}</p>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('share query', () => {
  it('fetches once when the page mounts twice', async () => {
    const api = mockApi(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse(brew);
    });
    const client = testQueryClient();
    const view = render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>
      </StrictMode>,
    );
    expect(await screen.findByText('Shared')).toBeInTheDocument();
    // Unmount while nothing is cached yet would cancel; remounting reuses the result.
    view.unmount();
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Shared')).toBeInTheDocument();
    expect(api.requests.filter((r) => r.path === '/api/brews/share/share1')).toHaveLength(1);
  });

  it('an unmount during the request does not ask a second time', async () => {
    let release = () => {};
    const api = mockApi(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse(brew));
        }),
    );
    const client = testQueryClient();
    const first = render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(api.requests).toHaveLength(1));
    first.unmount();
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    release();
    expect(await screen.findByText('Shared')).toBeInTheDocument();
    expect(api.requests).toHaveLength(1);
  });
});
