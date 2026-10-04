import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, clearApiCache, fetchPlayerStats, parseLink, validateUsername } from '../src/api';

const API = 'https://api.github.com';
const profile = { login: 'octocat', name: null, avatar_url: 'https://avatars.githubusercontent.com/u/1', public_repos: 2, followers: 5 };
const repo = (id: number, stars = 4, language: string | null = 'TypeScript'): object => ({ id, owner: { login: 'octocat' }, name: `repo-${id}`, stargazers_count: stars, language, private: false });
function response(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const mock = vi.fn<typeof fetch>();

beforeEach(() => { clearApiCache(); mock.mockReset(); vi.stubGlobal('fetch', mock); });
afterEach(() => { clearApiCache(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function happy(repos: object[] = [], total = 0): void {
  mock.mockResolvedValueOnce(response(profile)).mockResolvedValueOnce(response(repos)).mockResolvedValueOnce(response({ total_count: total, incomplete_results: false }));
}

describe('API data and cache', () => {
  it('calculates zero-data boundaries and falls back to username for null name', async () => {
    happy();
    const player = await fetchPlayerStats(' octocat ');
    expect(player).toMatchObject({ username: 'octocat', name: 'octocat', hp: 100, atk: 10, commits: 0, stars: 0 });
    expect(player.skills[0]?.name).toBe('普通攻击');
  });
  it('reads all pages, deduplicates repositories, ignores private and null languages', async () => {
    mock.mockResolvedValueOnce(response(profile))
      .mockResolvedValueOnce(response([repo(1, 300), repo(2, 7, null)], 200, { link: `<${API}/users/octocat/repos?page=2>; rel="next"` }))
      .mockResolvedValueOnce(response([repo(1, 300), repo(3, 1), { ...repo(4, 900), private: true }]))
      .mockResolvedValueOnce(response({ total_count: 700, incomplete_results: false }));
    const player = await fetchPlayerStats('octocat');
    expect(player).toMatchObject({ stars: 308, hp: 308, atk: 14, commitSource: 'search' });
    expect(player.skills[0]?.count).toBe(2);
    expect(mock).toHaveBeenCalledTimes(4);
  });
  it('shares in-flight requests and serves case-insensitive cloned cache results', async () => {
    happy();
    const [first, second] = await Promise.all([fetchPlayerStats('octocat'), fetchPlayerStats('OCTOCAT')]);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(await fetchPlayerStats('octocat')).toEqual(first);
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it('expires the memory cache after five minutes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    happy(); await fetchPlayerStats('octocat');
    now.mockReturnValue(301001);
    happy(); await fetchPlayerStats('octocat');
    expect(mock).toHaveBeenCalledTimes(6);
    now.mockRestore();
  });
  it('invalidates cache when the PAT changes and only sends it to GitHub', async () => {
    happy(); await fetchPlayerStats('octocat');
    happy(); await fetchPlayerStats('octocat', { token: 'test-only-token' });
    expect(mock).toHaveBeenCalledTimes(6);
    const call = mock.mock.calls[3];
    expect(call?.[1]?.headers).toMatchObject({ Authorization: 'Bearer test-only-token' });
    expect(mock.mock.calls.every(([url]) => String(url).startsWith(`${API}/`))).toBe(true);
  });
  it('validates usernames and rejects cross-origin Link URLs', () => {
    expect(validateUsername(' Torvalds ')).toBe('Torvalds');
    for (const value of ['', '../foo', 'bad--name', 'foo bar', '-foo']) expect(() => validateUsername(value)).toThrow();
    expect(() => parseLink('<https://example.com/steal>; rel="next"', 'next')).toThrow();
  });
});

describe('commit fallback', () => {
  it('falls back on incomplete search and handles last page, single page, empty repos', async () => {
    mock.mockResolvedValueOnce(response(profile)).mockResolvedValueOnce(response([repo(1), repo(2), repo(3)]))
      .mockResolvedValueOnce(response({ total_count: 99, incomplete_results: true }))
      .mockResolvedValueOnce(response([{}], 200, { link: `<${API}/repos/octocat/repo-1/commits?per_page=1&page=17>; rel="last"` }))
      .mockResolvedValueOnce(response([{}]))
      .mockResolvedValueOnce(response({ message: 'Git Repository is empty.' }, 409));
    const player = await fetchPlayerStats('octocat');
    expect(player).toMatchObject({ commits: 18, commitSource: 'repositories', repositoriesCounted: 3, truncated: false });
    expect(mock.mock.calls[3]?.[0]).toBe(`${API}/repos/octocat/repo-1/commits?per_page=1`);
  });
  it('falls back on search network failure', async () => {
    mock.mockResolvedValueOnce(response(profile)).mockResolvedValueOnce(response([repo(1)]))
      .mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(response([]));
    expect(await fetchPlayerStats('octocat')).toMatchObject({ commits: 0, commitSource: 'repositories' });
  });
  it('counts only the first 50 repositories and labels truncation', async () => {
    mock.mockResolvedValueOnce(response(profile)).mockResolvedValueOnce(response(Array.from({ length: 51 }, (_, i) => repo(i))))
      .mockResolvedValueOnce(response({}, 503));
    mock.mockImplementation(async () => response([{}]));
    expect(await fetchPlayerStats('octocat')).toMatchObject({ commits: 50, repositoriesCounted: 50, truncated: true });
    expect(mock).toHaveBeenCalledTimes(53);
  });
  it('search rate exhaustion does not block the core fallback', async () => {
    mock.mockResolvedValueOnce(response(profile)).mockResolvedValueOnce(response([repo(1)]))
      .mockResolvedValueOnce(response({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 60) }))
      .mockResolvedValueOnce(response([{}]));
    expect(await fetchPlayerStats('octocat')).toMatchObject({ commits: 1, commitSource: 'repositories' });
  });
  it('stops when the core quota is exhausted and does not fabricate commits', async () => {
    mock.mockResolvedValueOnce(response(profile))
      .mockResolvedValueOnce(response([repo(1)], 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 60) }))
      .mockResolvedValueOnce(response({}, 503));
    await expect(fetchPlayerStats('octocat')).rejects.toMatchObject({ kind: 'rate-limit', resource: 'core' });
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it('does not treat every 409 as an empty repository', async () => {
    mock.mockResolvedValueOnce(response(profile)).mockResolvedValueOnce(response([repo(1)]))
      .mockResolvedValueOnce(response({}, 503)).mockResolvedValueOnce(response({ message: 'Conflict' }, 409));
    await expect(fetchPlayerStats('octocat')).rejects.toMatchObject({ status: 409 });
  });
});

describe('failure, cancellation and recovery', () => {
  it('reports missing users and permits a later retry', async () => {
    mock.mockResolvedValueOnce(response({}, 404));
    await expect(fetchPlayerStats('octocat')).rejects.toMatchObject({ kind: 'not-found' });
    happy();
    await expect(fetchPlayerStats('octocat')).resolves.toMatchObject({ username: 'octocat' });
  });
  it('reports invalid PAT and does not try the commit fallback', async () => {
    mock.mockResolvedValueOnce(response(profile)).mockResolvedValueOnce(response([repo(1)]))
      .mockResolvedValueOnce(response({}, 401));
    await expect(fetchPlayerStats('octocat', { token: 'invalid-test-token' })).rejects.toMatchObject({ kind: 'authentication' });
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it('exposes rate reset time', async () => {
    const reset = Math.ceil(Date.now() / 1000) + 60;
    mock.mockResolvedValueOnce(response({}, 429, { 'x-ratelimit-reset': String(reset) }));
    await expect(fetchPlayerStats('octocat')).rejects.toMatchObject({ kind: 'rate-limit', resetAt: reset * 1000 });
  });
  it('converts network failures to a retryable friendly error', async () => {
    mock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(fetchPlayerStats('octocat')).rejects.toBeInstanceOf(ApiError);
    happy();
    await expect(fetchPlayerStats('octocat')).resolves.toMatchObject({ hp: 100 });
  });
  it('one cancelled consumer does not cancel another shared consumer', async () => {
    happy();
    const controller = new AbortController();
    const first = fetchPlayerStats('octocat', { signal: controller.signal });
    const second = fetchPlayerStats('octocat');
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toMatchObject({ username: 'octocat' });
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it('rejects malformed responses instead of silently using zero values', async () => {
    mock.mockResolvedValueOnce(response({ ...profile, followers: 'bad' })).mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ total_count: 0, incomplete_results: false }));
    await expect(fetchPlayerStats('octocat')).rejects.toMatchObject({ kind: 'response' });
  });
  it('times out a stalled request and exposes the timeout reason', async () => {
    vi.useFakeTimers();
    mock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const checking = expect(fetchPlayerStats('octocat')).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(15001);
    await checking;
  });
  it('serializes all users through one shared request queue', async () => {
    let active = 0;
    let highest = 0;
    mock.mockImplementation(async url => {
      active += 1; highest = Math.max(highest, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
      if (String(url).includes('/search/')) return response({ total_count: 0, incomplete_results: false });
      return response(String(url).includes('/repos?') ? [] : profile);
    });
    await Promise.all([fetchPlayerStats('octocat'), fetchPlayerStats('torvalds')]);
    expect(highest).toBe(1);
    expect(mock).toHaveBeenCalledTimes(6);
  });
});
