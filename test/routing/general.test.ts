import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../../src/index';

describe('General routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects /install to the raw GitHub install script', async () => {
    const request = new Request('https://proxy.example/install');
    const response = await worker.fetch(request);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://raw.githubusercontent.com/khrees/pontis/main/install.sh');
  });

  it('serves interactive HTML documentation at /docs', async () => {
    const request = new Request('https://proxy.example/docs');
    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('Pontis');
  });
});
