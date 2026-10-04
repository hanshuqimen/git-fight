import '../../src/style.css';
import { clearApiCache } from '../../src/api';
import { Arena } from '../../src/ui';

// Dev-only integration fixture. This HTML/TS entry is not part of the production build.
const mode = document.querySelector<HTMLSelectElement>('#fixture-mode');
const counter = document.querySelector<HTMLElement>('#fixture-request-count');
const root = document.querySelector<HTMLElement>('#app');
if (!mode || !counter || !root) throw new Error('测试挂载节点缺失。');
let requests = 0;
mode.addEventListener('change', clearApiCache);
const originalFetch = window.fetch.bind(window);
const params = new URLSearchParams(window.location.search);
if (params.get('motion') === 'reduce') {
  const originalMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = query => {
    const result = originalMatchMedia(query);
    if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(result, 'matches', { value: true });
    return result;
  };
  const note = document.querySelector('#fixture-motion');
  if (note) note.textContent = '测试：减少动效已开启';
}
window.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== 'https://api.github.com') return originalFetch(input, options);
  requests += 1; counter.textContent = String(requests);
  if (mode.value === 'network') throw new TypeError('Fixture offline');
  if (mode.value === 'slow') {
    await new Promise<void>((resolve, reject) => {
      const signal = options?.signal;
      const cancel = (): void => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, 5000);
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
  }
  const send = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const username = url.pathname.split('/')[2] ?? '';
  if (url.pathname.startsWith('/users/') && !url.pathname.endsWith('/repos')) {
    if (mode.value === 'missing') return send({ message: 'Not Found' }, 404);
    const left = username.toLowerCase() === 'octocat';
    return send({ login: username, name: mode.value === 'long-name' ? '<script>alert("xss")</script> 特别特别特别长的开发者昵称 · '.repeat(4) : left ? 'The Octocat（模拟）' : 'Linus Torvalds（模拟）', avatar_url: mode.value === 'avatar' ? 'https://invalid.example/avatar.png' : `https://avatars.githubusercontent.com/u/${left ? '583231' : '1024025'}?s=160`, public_repos: 4, followers: left ? 100 : 200 });
  }
  if (url.pathname.endsWith('/repos')) {
    const left = username.toLowerCase() === 'octocat';
    return send(Array.from({ length: 4 }, (_, i) => ({ id: (left ? 100 : 200) + i, name: `fixture-${i}`, owner: { login: username }, stargazers_count: mode.value === 'long-battle' ? 500 : mode.value === 'burst' ? 25 : left ? 100 : 125, language: mode.value === 'no-language' ? null : i < 2 ? left ? 'TypeScript' : 'C' : i === 2 ? 'Python' : 'Rust', private: false })));
  }
  if (url.pathname === '/search/commits') return send({ total_count: mode.value === 'long-battle' ? 500 : mode.value === 'burst' ? 50000 : (url.searchParams.get('q') ?? '').includes('octocat') ? 4000 : 4500, incomplete_results: false });
  return send([]);
};
new Arena(root);
