import { buildSkills } from './battle';
import type { PlayerStats } from './types';

const API = 'https://api.github.com';
const CACHE_TTL = 5 * 60 * 1000;
const REQUEST_TIMEOUT = 15_000;
type Resource = 'core' | 'search';
type ErrorKind = 'not-found' | 'authentication' | 'rate-limit' | 'network' | 'timeout' | 'response';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly status = 0,
    readonly resetAt: number | null = null,
    readonly resource: Resource = 'core',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface FetchOptions {
  readonly token?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
}

interface Repository { id: number; owner: string; name: string; stars: number; language: string | null }
interface Flight { promise: Promise<PlayerStats>; controller: AbortController; consumers: number }
const cache = new Map<string, { expires: number; player: PlayerStats }>();
const inFlight = new Map<string, Flight>();
const limits = new Map<Resource, number>();
let currentToken = '';
let generation = 0;
let queue: Promise<void> = Promise.resolve();

export function clearApiCache(): void {
  cache.clear();
  for (const flight of inFlight.values()) flight.controller.abort();
  inFlight.clear();
  limits.clear();
  generation += 1;
}

export function validateUsername(value: string): string {
  const username = value.trim();
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username) || username.includes('--')) {
    throw new Error('请输入有效的 GitHub 用户名（1–39 个字母、数字或单连字符）。');
  }
  return username;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ApiError('GitHub 返回的数据格式异常，请重试。', 'response');
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError('GitHub 返回的数据字段异常，请重试。', 'response');
  return value;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ApiError('GitHub 返回的计数异常，请重试。', 'response');
  return value;
}

export function parseLink(header: string | null, relation: string): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === relation && match[1]) {
      const url = new URL(match[1]);
      if (url.origin !== API) throw new ApiError('GitHub 分页地址异常，请重试。', 'response');
      return url.href;
    }
  }
  return null;
}

function abortError(): DOMException { return new DOMException('请求已取消。', 'AbortError'); }

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function request(url: string, token: string, signal: AbortSignal, resource: Resource, epoch: number): Promise<{ data: unknown; headers: Headers }> {
  return enqueue(async () => {
    if (signal.aborted) throw abortError();
    if (new URL(url).origin !== API) throw new ApiError('请求地址异常。', 'response');
    const reset = limits.get(resource);
    if (reset && Date.now() < reset) throw new ApiError('GitHub API 额度已用尽，请在重置后重试或填写 PAT。', 'rate-limit', 403, reset, resource);
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(url, { headers, signal: controller.signal, redirect: 'error', credentials: 'omit' });
      const remaining = response.headers.get('x-ratelimit-remaining');
      const rawReset = response.headers.get('x-ratelimit-reset');
      const resetAt = rawReset && Number.isFinite(Number(rawReset)) ? Number(rawReset) * 1000 : null;
      const retry = response.headers.get('retry-after');
      const retryAt = retry && Number.isFinite(Number(retry)) ? Date.now() + Number(retry) * 1000 : null;
      if (remaining === '0' && resetAt && epoch === generation) limits.set(resource, resetAt);
      if (!response.ok) {
        if (response.status === 404) throw new ApiError('用户不存在，请检查 GitHub 用户名。', 'not-found', 404);
        if (response.status === 401) throw new ApiError('PAT 无效或已过期，请修改 token，或清空后重试。', 'authentication', 401);
        if (response.status === 403 || response.status === 429) {
          const next = retryAt ?? resetAt;
          if (next && epoch === generation) limits.set(resource, next);
          throw new ApiError('GitHub API 访问受限，请稍后重试，或填写可选 PAT。', 'rate-limit', response.status, next, resource);
        }
        if (response.status === 409) {
          const body: unknown = await response.json();
          if (object(body).message === 'Git Repository is empty.') return { data: [], headers: response.headers };
        }
        throw new ApiError(`GitHub 请求失败（${response.status}），请重试。`, 'response', response.status, null, resource);
      }
      const data: unknown = await response.json();
      return { data, headers: response.headers };
    } catch (error: unknown) {
      if (signal.aborted) throw abortError();
      if (error instanceof ApiError) throw error;
      if (controller.signal.aborted) throw new ApiError('请求超时，请检查网络后重试。', 'timeout');
      throw new ApiError('网络连接失败，请检查网络后重试。', 'network');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
    }
  });
}

async function load(username: string, token: string, signal: AbortSignal, progress: FetchOptions['onProgress'], epoch: number): Promise<PlayerStats> {
  const get = (url: string, resource: Resource = 'core'): Promise<{ data: unknown; headers: Headers }> => request(url, token, signal, resource, epoch);
  progress?.(`${username} · 正在读取用户信息`);
  const profile = object((await get(`${API}/users/${encodeURIComponent(username)}`)).data);
  const login = text(profile.login);
  const repositories = new Map<number, Repository>();
  let url: string | null = `${API}/users/${encodeURIComponent(login)}/repos?per_page=100&sort=updated`;
  const visited = new Set<string>();
  while (url) {
    if (visited.has(url)) throw new ApiError('GitHub 分页重复，请重试。', 'response');
    visited.add(url);
    progress?.(`${login} · 已读取 ${repositories.size} 个仓库`);
    const response = await get(url);
    if (!Array.isArray(response.data)) throw new ApiError('仓库列表格式异常，请重试。', 'response');
    for (const value of response.data) {
      const repo = object(value);
      if (repo.private === true) continue;
      const item: Repository = {
        id: count(repo.id), owner: text(object(repo.owner).login), name: text(repo.name),
        stars: count(repo.stargazers_count), language: repo.language === null ? null : text(repo.language),
      };
      repositories.set(item.id, item);
    }
    url = parseLink(response.headers.get('link'), 'next');
  }
  const repos = [...repositories.values()];
  let commits = 0;
  let commitSource: PlayerStats['commitSource'] = 'search';
  let repositoriesCounted = 0;
  let truncated = false;
  progress?.(`${login} · 正在搜索作者提交`);
  try {
    const search = object((await get(`${API}/search/commits?q=${encodeURIComponent(`author:${login}`)}&per_page=1`, 'search')).data);
    if (search.incomplete_results !== false) throw new ApiError('搜索结果不完整。', 'response');
    commits = count(search.total_count);
  } catch (error: unknown) {
    if (signal.aborted) throw abortError();
    if (error instanceof ApiError && error.kind === 'authentication') throw error;
    commitSource = 'repositories';
    truncated = repos.length > 50;
    const selected = repos.slice(0, 50);
    for (const [index, repo] of selected.entries()) {
      progress?.(`${login} · 降级统计提交 ${index + 1}/${selected.length}`);
      const response = await get(`${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits?per_page=1`);
      if (!Array.isArray(response.data)) throw new ApiError('提交列表格式异常，请重试。', 'response');
      const last = parseLink(response.headers.get('link'), 'last');
      if (last) {
        const pages = Number(new URL(last).searchParams.get('page'));
        if (!Number.isSafeInteger(pages) || pages < 1) throw new ApiError('提交分页计数异常，请重试。', 'response');
        commits += pages;
      } else {
        if (parseLink(response.headers.get('link'), 'next')) throw new ApiError('提交分页缺少末页计数，请重试。', 'response');
        commits += response.data.length;
      }
      repositoriesCounted += 1;
    }
  }
  const languages: Record<string, number> = Object.create(null) as Record<string, number>;
  let stars = 0;
  for (const repo of repos) {
    stars += repo.stars;
    if (repo.language) languages[repo.language] = (languages[repo.language] ?? 0) + 1;
  }
  return {
    username: login, name: typeof profile.name === 'string' && profile.name ? profile.name : login,
    avatarUrl: text(profile.avatar_url), publicRepos: count(profile.public_repos), followers: count(profile.followers),
    stars, commits, hp: Math.max(100, stars), atk: Math.max(10, Math.round(commits / 50)),
    skills: buildSkills(languages), commitSource, repositoriesCounted, truncated,
  };
}

function consume(flight: Flight, signal: AbortSignal | undefined): Promise<PlayerStats> {
  flight.consumers += 1;
  return new Promise<PlayerStats>((resolve, reject) => {
    let completed = false;
    const finish = (action: () => void): void => {
      if (completed) return;
      completed = true;
      signal?.removeEventListener('abort', cancel);
      flight.consumers -= 1;
      if (flight.consumers === 0) flight.controller.abort();
      action();
    };
    const cancel = (): void => finish(() => reject(abortError()));
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    flight.promise.then(player => finish(() => resolve(structuredClone(player))), error => finish(() => reject(error)));
  });
}

export function fetchPlayerStats(input: string, options: FetchOptions = {}): Promise<PlayerStats> {
  const username = validateUsername(input);
  const token = options.token?.trim() ?? '';
  if (token !== currentToken) { clearApiCache(); currentToken = token; }
  if (options.signal?.aborted) return Promise.reject(abortError());
  const key = username.toLowerCase();
  const saved = cache.get(key);
  if (saved && saved.expires > Date.now()) {
    options.onProgress?.(`${saved.player.username} · 使用本次会话缓存`);
    return Promise.resolve(structuredClone(saved.player));
  }
  let flight = inFlight.get(key);
  if (!flight || flight.controller.signal.aborted) {
    const epoch = generation;
    const controller = new AbortController();
    const promise = load(username, token, controller.signal, options.onProgress, epoch).then(player => {
      if (epoch === generation && !controller.signal.aborted) cache.set(key, { expires: Date.now() + CACHE_TTL, player });
      return player;
    }).finally(() => {
      if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
    });
    flight = { promise, controller, consumers: 0 };
    inFlight.set(key, flight);
  }
  return consume(flight, options.signal);
}
