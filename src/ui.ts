import { ApiError, clearApiCache, fetchPlayerStats, validateUsername } from './api';
import { createBattle, finishBattle, getAvailableActions, resolveTurn, validateSeed } from './battle';
import { downloadResultCard, renderResultCard, safeAvatarUrl } from './card';
import { BattleEffects, PresentationClock, effectFamily } from './effects';
import type { AttackChoice, BattleEvent, BattleLog, BattleState, PlayerStats, Side } from './types';

type AppState = { screen: 'config' | 'loading' } | { screen: 'battle'; battle: BattleState; replay?: BattleLog } | { screen: 'result'; log: BattleLog };
const number = (value: number): string => value.toLocaleString('en-US', { maximumFractionDigits: 1 });
const compact = (value: number): string => value.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
const bolt = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-13h-8l1-7Z"/></svg>';
const arrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const star = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg>';

function requireElement<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`界面缺少元素：${selector}`);
  return element;
}

function sourceLabel(player: PlayerStats): string {
  return player.commitSource === 'search' ? '作者提交搜索' : `仓库提交降级统计 · ${player.repositoriesCounted} 个仓库${player.truncated ? ' · 已截断至前 50 个' : ''}`;
}

function cardMarkup(player: PlayerStats, side: Side): string {
  const avatar = safeAvatarUrl(player.avatarUrl);
  return `<article class="fighter ${side}" id="fighter-${side}" aria-label="${escape(player.username)} 的卡牌">
    <div class="fighter-top"><span class="eyebrow">${side === 'left' ? '01 / CYAN' : '02 / AMBER'}</span><span class="status-dot" id="role-${side}">就绪</span></div>
    <div class="fighter-identity"><div class="avatar"><span>${escape(player.username.slice(0, 1).toUpperCase())}</span>${avatar ? `<img src="${escape(avatar)}" crossorigin="anonymous" width="76" height="76" alt="${escape(player.username)} 的头像"/>` : ''}</div><h2>${escape(player.name)}</h2><p class="mono">@${escape(player.username)}</p></div>
    <div class="health-label"><span>HP <strong id="hp-${side}">${number(player.hp)}</strong></span><span class="muted">/ ${number(player.hp)}</span></div>
    <div class="health-track" role="progressbar" aria-label="${escape(player.username)} 的 HP" aria-valuemin="0" aria-valuemax="${player.hp}" aria-valuenow="${player.hp}"><div id="bar-${side}" class="health-fill"></div></div>
    <div class="fighter-stats"><div><span>攻击力 / ATK</span><strong>${number(player.atk)}</strong></div><div><span>总 STAR</span><strong>${compact(player.stars)}</strong></div></div>
    <div class="skill-list">${player.skills.map((skill, index) => `<div class="skill" id="skill-${side}-${index}"><span>${bolt}${escape(skill.name)}</span><strong>${skill.multiplier.toFixed(2)}×</strong></div>`).join('')}</div>
    <details class="fighter-meta"><summary>${compact(player.commits)} commits · ${compact(player.publicRepos)} repos</summary><small>${escape(sourceLabel(player))}</small></details>
    <div class="damage-zone" aria-hidden="true"></div>
  </article>`;
}

export class Arena {
  private state: AppState = { screen: 'config' };
  private values = { left: 'octocat', right: 'torvalds', seed: '', token: '' };
  private request: AbortController | null = null;
  private playback: AbortController | null = null;
  private revision = 0;
  private canvas: HTMLCanvasElement | null = null;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private canvasRevision = 0;
  private control: Side | 'auto' = 'left';
  private speed = 3000;
  private clock = new PresentationClock();
  private effects: BattleEffects | null = null;
  private waitingForPlayer = false;
  private playingAttack = false;
  private pausedAnimations: Animation[] = [];

  constructor(private readonly root: HTMLElement) {
    this.root.addEventListener('keydown', event => {
      if (event.repeat || this.state.screen !== 'battle' || this.root.querySelector('dialog[open]')) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, select, textarea, [contenteditable="true"]')) return;
      if (/^[1-4]$/.test(event.key) && this.waitingForPlayer && !this.clock.paused) {
        const button = this.root.querySelector<HTMLButtonElement>(`[data-action="${Number(event.key) - 1}"]`);
        if (button && !button.disabled) { event.preventDefault(); button.click(); }
      } else if (event.key.toLowerCase() === 'p') { event.preventDefault(); this.togglePause(); }
    });
    this.render();
  }

  private transition(state: AppState): void {
    this.revision += 1;
    this.canvasRevision += 1;
    this.request?.abort();
    this.request = null;
    this.playback?.abort();
    this.playback = null;
    this.effects?.dispose(); this.effects = null;
    this.clock = new PresentationClock();
    this.waitingForPlayer = false; this.playingAttack = false;
    this.root.classList.remove('playback-paused');
    this.pausedAnimations = [];
    this.state = state;
    this.canvas = null;
    this.render();
  }

  private render(): void {
    this.root.dataset.screen = this.state.screen;
    const step = this.state.screen === 'config' || this.state.screen === 'loading' ? 1 : this.state.screen === 'battle' ? 2 : 3;
    this.root.innerHTML = `<a class="skip-link" href="#main">跳至主要内容</a>
      <header class="header"><a class="brand" href="#" aria-label="git-fight 首页"><span class="brand-icon">${bolt}</span>git<span class="brand-dash">-</span>fight<span class="version">ARENA / 02</span></a><span class="header-note"><span class="online-dot"></span> GitHub 数据驱动的代码竞技场</span><button class="text-button" id="rules-button">对战规则 <span>↗</span></button></header>
      <main id="main" tabindex="-1"><nav class="steps" aria-label="对战进度">${['配置对决', '代码交锋', '战果出炉'].map((label, index) => `<span class="step ${index + 1 === step ? 'current' : ''}" ${index + 1 === step ? 'aria-current="step"' : ''}><b>0${index + 1}</b> ${label}</span>${index < 2 ? '<i aria-hidden="true"></i>' : ''}`).join('')}</nav><div id="screen"></div></main>
      <footer><span>Built for developers. Just for fun.</span><span>PUBLIC DATA <span class="footer-separator">/</span> DETERMINISTIC BATTLES <span class="footer-separator">/</span> NO SIGN-IN</span></footer>
      <dialog id="rules-dialog"><div class="dialog-top"><span class="eyebrow">HOW IT WORKS</span><button id="close-rules" class="text-button">关闭 ✕</button></div><h2>让代码，说话。</h2><p>HP = max(100, 总 star)；ATK = max(10, round(commit / 50))。</p><p>前 3 名语言成为技能；倍率为语言仓库数除以入选语言仓库数均值，最低 1×，抽取权重为仓库数。没有语言时使用普通攻击。</p><p>ATK 高者先手，同值左侧先手。每次伤害随机浮动 0.8–1.2×，15% 概率触发 1.5× 暴击。最多 30 次攻击，未击倒时比较剩余 HP 比例，相等为平局。</p><p>语言技能使用后，下一个己方回合不可用，再下个己方回合恢复。普通攻击为 1×，始终可用。AI 按可用语言技能的仓库数加权选择。相同 seed、数据与选招序列产生相同战报；重播直接使用本局记录。</p><p class="muted">搜索失败时使用最近更新的前 50 个仓库的提交数。它包含其他作者的提交，与作者搜索口径不同。公开数据仅供娱乐。</p></dialog>`;
    requireElement<HTMLAnchorElement>(this.root, '.brand').addEventListener('click', event => { event.preventDefault(); this.transition({ screen: 'config' }); });
    const dialog = requireElement<HTMLDialogElement>(this.root, '#rules-dialog');
    requireElement(this.root, '#rules-button').addEventListener('click', () => dialog.showModal());
    requireElement(this.root, '#close-rules').addEventListener('click', () => dialog.close());
    if (this.state.screen === 'config' || this.state.screen === 'loading') this.renderConfig();
    else if (this.state.screen === 'battle') this.renderBattle(this.state.battle, this.state.replay);
    else if (this.state.screen === 'result') this.renderResult(this.state.log);
    this.root.querySelectorAll<HTMLImageElement>('.avatar img').forEach(img => img.addEventListener('error', () => { img.hidden = true; }));
  }

  private renderConfig(): void {
    const loading = this.state.screen === 'loading';
    requireElement(this.root, '#screen').innerHTML = `<section class="config-screen">
      <div class="hero"><div class="hero-label"><span class="live-dot"></span> THE DEVELOPER BATTLE ARENA</div><h1>代码已就位。<br/><span class="hero-accent">这次，你来出招。</span></h1><p>Commit 化作攻击，Star 铸成血量。<br/>选择你的 GitHub 身份，用编程语言迎战对手。</p><div class="formula-chips"><span>${bolt} COMMIT → ATK</span><span>${star} STAR → HP</span><span><b class="code-glyph">&lt;/&gt;</b> LANGUAGE → SKILL</span></div><div class="hero-decoration" aria-hidden="true"><div class="deco-code">git commit -m "ready to fight"</div><div class="deco-line"></div><span class="deco-left">01</span><span class="deco-vs">VS</span><span class="deco-right">02</span><p>WRITE CODE. DEAL DAMAGE.</p></div></div>
      <div class="config-panel"><div class="panel-title"><div><span class="eyebrow">NEW MATCH</span><h2>选择你的对手</h2></div><span class="panel-symbol">${bolt}</span></div>
        <form id="match-form" novalidate><div class="opponent-field left"><label for="left-user"><span class="player-number">01</span> 挑战者</label><div class="username-input"><span>@</span><input id="left-user" name="left" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="GitHub 用户名" maxlength="39" aria-describedby="left-error" ${loading ? 'disabled' : ''}/></div><p id="left-error" class="field-error"></p></div>
        <div class="form-vs"><span></span><b>VERSUS</b><span></span></div>
        <div class="opponent-field right"><label for="right-user"><span class="player-number">02</span> 应战者</label><div class="username-input"><span>@</span><input id="right-user" name="right" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="GitHub 用户名" maxlength="39" aria-describedby="right-error" ${loading ? 'disabled' : ''}/></div><p id="right-error" class="field-error"></p></div>
        <div class="mode-field"><label for="match-mode">对战方式</label><select id="match-mode" ${loading ? 'disabled' : ''}><option value="left">操控左侧 · 右侧程序迎战</option><option value="right">操控右侧 · 左侧程序迎战</option><option value="auto">自动观战 · 双方程序出招</option></select><p class="input-help">语言技能冷却一个己方回合，普通攻击始终可用。</p></div><details class="advanced"><summary>高级设置 <span>可选 PAT / Seed</span></summary><div class="advanced-fields"><label for="token">GitHub PAT <span>仅存当前页面内存</span></label><input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="留空也可对战" ${loading ? 'disabled' : ''}/><p class="input-help">提高 API 额度。只用于读取公开数据，不会保存。</p><label for="seed">随机 Seed</label><input id="seed" inputmode="numeric" placeholder="自动使用当前时间" aria-describedby="seed-error" ${loading ? 'disabled' : ''}/><p class="input-help">非负安全整数；0 有效。手动对战还需相同选招序列才能复现。</p><p id="seed-error" class="field-error"></p></div></details>
        <div id="form-error" class="error-box" role="alert" tabindex="-1" hidden></div><div id="load-progress" class="load-progress" role="status" ${loading ? '' : 'hidden'}><span class="loading-label"><span class="spinner"></span> 正在打造双方卡牌</span><p id="progress-left">等待读取挑战者数据…</p><p id="progress-right">等待读取应战者数据…</p></div>
        <button class="button primary launch" type="submit" ${loading ? 'disabled' : ''}>${loading ? '读取 GitHub 数据中…' : `开始对决 ${arrow}`}</button>${loading ? '<button class="button secondary cancel-load" type="button" id="cancel-load">取消读取</button>' : ''}<p class="form-footnote"><span class="online-dot"></span> 无需登录 · 仅使用公开 GitHub 数据</p></form>
      </div></section>`;
    const left = requireElement<HTMLInputElement>(this.root, '#left-user');
    const right = requireElement<HTMLInputElement>(this.root, '#right-user');
    const token = requireElement<HTMLInputElement>(this.root, '#token');
    const seed = requireElement<HTMLInputElement>(this.root, '#seed');
    const mode = requireElement<HTMLSelectElement>(this.root, '#match-mode');
    mode.value = this.control;
    mode.addEventListener('change', () => { this.control = mode.value === 'right' ? 'right' : mode.value === 'auto' ? 'auto' : 'left'; });
    left.value = this.values.left; right.value = this.values.right; token.value = this.values.token; seed.value = this.values.seed;
    token.addEventListener('input', () => { if (token.value !== this.values.token) clearApiCache(); this.values.token = token.value; });
    left.addEventListener('input', () => { this.values.left = left.value; });
    right.addEventListener('input', () => { this.values.right = right.value; });
    seed.addEventListener('input', () => { this.values.seed = seed.value; });
    requireElement<HTMLFormElement>(this.root, '#match-form').addEventListener('submit', event => {
      event.preventDefault();
      if (!loading) void this.startMatch();
    });
    this.root.querySelector('#cancel-load')?.addEventListener('click', () => this.transition({ screen: 'config' }));
  }

  private async startMatch(): Promise<void> {
    if (this.state.screen !== 'config') return;
    let valid = true;
    for (const side of ['left', 'right'] as const) {
      const field = requireElement<HTMLInputElement>(this.root, `#${side}-user`);
      const error = requireElement(this.root, `#${side}-error`);
      try { this.values[side] = validateUsername(this.values[side]); field.removeAttribute('aria-invalid'); error.textContent = ''; }
      catch (reason: unknown) { valid = false; field.setAttribute('aria-invalid', 'true'); error.textContent = reason instanceof Error ? reason.message : '用户名无效'; }
    }
    const rawSeed = this.values.seed.trim();
    let seed = Date.now();
    try {
      if (rawSeed) {
        if (!/^\d+$/.test(rawSeed)) throw new Error('Seed 必须是非负安全整数。');
        seed = Number(rawSeed); validateSeed(seed);
      }
      requireElement(this.root, '#seed-error').textContent = '';
      requireElement(this.root, '#seed').removeAttribute('aria-invalid');
    } catch (reason: unknown) {
      valid = false;
      requireElement(this.root, '#seed-error').textContent = reason instanceof Error ? reason.message : 'Seed 无效';
      requireElement(this.root, '#seed').setAttribute('aria-invalid', 'true');
      requireElement<HTMLDetailsElement>(this.root, '.advanced').open = true;
    }
    if (!valid) { this.root.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); return; }
    this.transition({ screen: 'loading' });
    const revision = this.revision;
    const controller = new AbortController();
    this.request = controller;
    let failedSide: Side | null = null;
    const get = async (side: Side): Promise<PlayerStats> => {
      try {
        return await fetchPlayerStats(this.values[side], { token: this.values.token, signal: controller.signal, onProgress: message => {
          if (revision === this.revision) requireElement(this.root, `#progress-${side}`).textContent = message;
        } });
      } catch (error: unknown) { if (!controller.signal.aborted) failedSide = side; throw error; }
    };
    try {
      const [left, right] = await Promise.all([get('left'), get('right')]);
      if (revision !== this.revision || controller.signal.aborted) return;
      this.transition({ screen: 'battle', battle: createBattle(left, right, seed, { mode: this.control === 'auto' ? 'auto' : 'interactive', controlledSide: this.control === 'auto' ? null : this.control }) });
    } catch (error: unknown) {
      if (revision !== this.revision || controller.signal.aborted) return;
      this.transition({ screen: 'config' });
      const errorBox = requireElement(this.root, '#form-error');
      const reset = error instanceof ApiError && error.resetAt ? ` 预计重置时间：${new Date(error.resetAt).toLocaleString('zh-CN')}。` : '';
      errorBox.textContent = `${failedSide ? `${this.values[failedSide]}：` : ''}${error instanceof Error ? error.message : '数据读取失败，请重试。'}${reset}`;
      errorBox.hidden = false;
      errorBox.focus();
      if (error instanceof ApiError && error.kind === 'not-found' && failedSide) {
        const field = requireElement(this.root, `#${failedSide}-user`);
        field.setAttribute('aria-invalid', 'true');
        requireElement(this.root, `#${failedSide}-error`).textContent = '用户不存在，请检查用户名。';
        field.focus();
      }
      requireElement<HTMLButtonElement>(this.root, '.launch').textContent = '重试对决 →';
    }
  }


  private renderBattle(battle: BattleState, replay?: BattleLog): void {
    const controlled = battle.controlledSide;
    const modeLabel = replay ? '本局回放' : controlled ? `你操控 @${battle.players[controlled].username}` : '自动观战';
    requireElement(this.root, '#screen').innerHTML = `<section class="battle-screen">
      <div class="screen-heading"><div><span class="eyebrow">HOLOGRAPHIC ARENA / 01</span><h1>代码交锋<span class="heading-dot">.</span></h1></div><div class="match-badges"><span class="mode-badge">${escape(modeLabel)}</span><span class="seed-badge mono">SEED ${battle.seed}</span></div></div>
      <div class="arena-board ${this.reducedMotion.matches ? 'reduced-effects' : ''}">
        <div class="arena-grid" aria-hidden="true"></div><div class="arena-floor" aria-hidden="true"></div>
        ${cardMarkup(battle.players.left, 'left')}
        <div class="arena-center"><span class="arena-ring" aria-hidden="true"></span><span class="vs">VS</span><span class="round-label">回合</span><strong id="round-counter">00</strong><span class="round-max">/ 30</span><div id="battle-status" role="status" aria-live="polite">双方已就位</div><span class="initiative-note">高 ATK 先手</span></div>
        ${cardMarkup(battle.players.right, 'right')}
        <div class="attack-banner" aria-hidden="true"><span></span><strong></strong><i>EXECUTE →</i></div>
        <div class="critical-cutin" aria-hidden="true"><span></span><strong>CRITICAL<span>暴击</span></strong></div>
        <div class="knockout-banner" aria-hidden="true">K.O.<span>连接终止 · 对战结束</span></div>
      </div>
      <div class="battle-toolbar"><button id="back-config" class="text-button">← 返回配置</button><div class="playback-controls"><label for="battle-speed">速度</label><select id="battle-speed"><option value="4000">慢速 · 4 秒</option><option value="3000">标准 · 3 秒</option><option value="1800">快速 · 1.8 秒</option></select><button id="pause-battle" class="button secondary" aria-pressed="false">暂停 · P</button><button id="skip-battle" class="button secondary">${replay ? '跳过回放' : battle.mode === 'auto' ? '查看结果' : '跳过本次动画'}</button></div></div>
      <section class="action-dock" aria-label="攻击选择"><div class="dock-heading"><div><span class="live-dot"></span><strong id="action-prompt">准备交锋</strong></div><span id="action-note">普通攻击始终可用 · 语言技能冷却一个己方回合</span></div><div id="action-buttons" class="action-buttons"></div></section>
      <details class="battle-feed" open><summary class="feed-title"><span>战斗记录</span><span class="eyebrow">LIVE COMBAT LOG</span></summary><ol id="battle-log" aria-label="逐回合战报"></ol></details>
    </section>`;
    for (const side of ['left', 'right'] as const) {
      requireElement(this.root, `#role-${side}`).textContent = controlled === side ? '你 / PLAYER' : '程序 / AI';
    }
    requireElement(this.root, '#back-config').addEventListener('click', () => this.transition({ screen: 'config' }));
    const speed = requireElement<HTMLSelectElement>(this.root, '#battle-speed');
    speed.value = String(this.speed);
    speed.addEventListener('change', () => { this.speed = Number(speed.value); });
    requireElement(this.root, '#pause-battle').addEventListener('click', () => this.togglePause());
    requireElement(this.root, '#skip-battle').addEventListener('click', () => {
      if (replay) this.transition({ screen: 'result', log: replay });
      else if (this.state.screen === 'battle' && this.state.battle.mode === 'auto') {
        let state = this.state.battle;
        while (!state.complete) state = resolveTurn(state);
        this.transition({ screen: 'result', log: finishBattle(state) });
      } else if (this.playingAttack && !this.clock.paused) this.clock.skip();
    });
    requireElement(this.root, '#main').focus();
    const controller = new AbortController(); this.playback = controller;
    this.effects = new BattleEffects(requireElement(this.root, '.arena-board'), this.clock, () => this.reducedMotion.matches);
    this.renderActions(battle, false, !!replay);
    if (replay) void this.playReplay(replay, controller.signal);
    else void this.runLive(controller.signal);
  }

  private togglePause(): void {
    if (this.state.screen !== 'battle') return;
    this.clock.paused = !this.clock.paused;
    if (this.clock.paused) {
      this.pausedAnimations = this.root.getAnimations({ subtree: true });
      this.pausedAnimations.forEach(animation => animation.pause());
    } else { this.pausedAnimations.forEach(animation => animation.play()); this.pausedAnimations = []; }
    this.root.classList.toggle('playback-paused', this.clock.paused);
    const button = requireElement(this.root, '#pause-battle');
    button.textContent = this.clock.paused ? '继续 · P' : '暂停 · P';
    button.setAttribute('aria-pressed', String(this.clock.paused));
    this.renderActions(this.state.battle, this.waitingForPlayer, !!this.state.replay);
    this.updateSkipButton();
  }

  private updateSkipButton(): void {
    if (this.state.screen !== 'battle') return;
    requireElement<HTMLButtonElement>(this.root, '#skip-battle').disabled =
      this.state.battle.mode === 'interactive' && !this.state.replay && (!this.playingAttack || this.clock.paused);
  }

  private renderActions(battle: BattleState, ready: boolean, replay = false): void {
    const side = battle.controlledSide ?? battle.attacker;
    const player = battle.players[side];
    requireElement(this.root, '.action-dock').style.setProperty('--accent', side === 'left' ? '#5ce8f5' : '#ff985c');
    const actions = getAvailableActions(battle, side);
    requireElement(this.root, '#action-prompt').textContent = replay ? '正在回放已记录的选招'
      : this.clock.paused ? '对战已暂停' : ready ? '轮到你了，选择攻击' : battle.mode === 'auto' ? '程序自动出招' : '等待对手行动';
    requireElement(this.root, '#action-note').textContent = replay ? '回放不改变结果，也不请求 GitHub'
      : ready ? '数字键 1–4 选招 · 不限时等待' : '语言技能使用后，下一个己方回合冷却';
    requireElement(this.root, '#action-buttons').innerHTML = actions.map((action, index) => {
      const enabled = ready && action.available && !this.clock.paused && !replay;
      const low = player.atk * action.skill.multiplier * .8;
      const high = player.atk * action.skill.multiplier * 1.2;
      return `<button class="attack-option ${action.cooldown ? 'on-cooldown' : ''}" data-action="${index}" data-family="${effectFamily(action.skill.name)}" ${enabled ? '' : 'disabled'} aria-label="${index + 1}，${escape(action.skill.name)}，${action.skill.multiplier.toFixed(2)}倍，${action.cooldown ? '冷却中' : '预计非暴击伤害 ' + number(low) + ' 至 ' + number(high)}">
        <span class="attack-key">${index + 1}</span><span class="attack-symbol" aria-hidden="true">${action.choice.kind === 'basic' ? '&gt;_' : effectFamily(action.skill.name) === 'vortex' ? '(λ)' : '&lt;/&gt;'}</span>
        <span class="attack-name">${escape(action.skill.name)}</span><strong>${action.skill.multiplier.toFixed(2)}×</strong>
        <span class="attack-range">${number(low)}–${number(high)} 伤害</span><span class="attack-state">${action.cooldown ? '冷却 · 本回合不可用' : action.choice.kind === 'basic' ? '无冷却' : '冷却 1 个己方回合'}</span></button>`;
    }).join('');
    this.root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
      button.addEventListener('click', () => {
        if (!this.waitingForPlayer || this.clock.paused || this.state.screen !== 'battle' || this.state.replay) return;
        const action = actions[Number(button.dataset.action)];
        if (!action?.available || !this.playback) return;
        this.waitingForPlayer = false;
        this.renderActions(this.state.battle, false);
        void this.runLive(this.playback.signal, { round: this.state.battle.events.length + 1, choice: action.choice });
      });
    });
    requireElement(this.root, '.action-dock').classList.toggle('your-turn', ready && !this.clock.paused);
  }

  private async runLive(signal: AbortSignal, command?: { round: number; choice: AttackChoice }): Promise<void> {
    if (this.state.screen !== 'battle' || signal.aborted) return;
    let state = this.state.battle;
    while (!signal.aborted) {
      if (state.complete) { this.transition({ screen: 'result', log: finishBattle(state) }); return; }
      const playerTurn = state.mode === 'interactive' && state.attacker === state.controlledSide;
      if (playerTurn && !command) {
        this.waitingForPlayer = true; this.playingAttack = false;
        requireElement(this.root, '#battle-status').textContent = '你的回合 · 等待选招';
        this.renderActions(state, true); this.updateSkipButton();
        this.root.querySelector<HTMLButtonElement>('[data-action]:not(:disabled)')?.focus({ preventScroll: true });
        return;
      }
      this.waitingForPlayer = false; this.playingAttack = false;
      this.renderActions(state, false); this.updateSkipButton();
      if (!playerTurn) {
        requireElement(this.root, '#battle-status').textContent = `@${state.players[state.attacker].username} 准备出招`;
        await this.clock.animate(500, signal, () => {});
        if (signal.aborted) return;
      }
      const next = resolveTurn(state, command); command = undefined;
      if (this.state.screen !== 'battle') return;
      this.state = { screen: 'battle', battle: next };
      const event = next.events.at(-1);
      if (!event) return;
      await this.presentEvent(event, next, signal);
      if (signal.aborted) return;
      state = next;
    }
  }

  private async playReplay(log: BattleLog, signal: AbortSignal): Promise<void> {
    await this.clock.animate(700, signal, () => {});
    for (const event of log.events) {
      if (signal.aborted || this.state.screen !== 'battle') return;
      await this.presentEvent(event, this.state.battle, signal);
    }
    if (!signal.aborted) this.transition({ screen: 'result', log });
  }

  private async presentEvent(event: BattleEvent, battle: BattleState, signal: AbortSignal): Promise<void> {
    this.playingAttack = true; this.updateSkipButton();
    const board = requireElement(this.root, '.arena-board');
    const attacker = requireElement(this.root, `#fighter-${event.attacker}`);
    const defender = requireElement(this.root, `#fighter-${event.defender}`);
    const index = battle.players[event.attacker].skills.findIndex(skill => skill.name === event.skill.name);
    const skill = this.root.querySelector(`#skill-${event.attacker}-${index}`);
    attacker.classList.add('casting'); skill?.classList.add('active');
    requireElement(this.root, '#round-counter').textContent = String(event.round).padStart(2, '0');
    requireElement(this.root, '#battle-status').textContent = `${battle.players[event.attacker].username} · ${event.skill.name}`;
    try {
      await this.effects?.play(event, battle.players, battle.seed, this.speed, signal, () => {
        if (signal.aborted) return;
        defender.classList.add('hit');
        if (event.critical) defender.classList.add('critical-hit');
        this.applyHp(event.hpAfter, battle);
        const floating = document.createElement('span');
        floating.className = `damage-number ${event.critical ? 'critical' : ''}`;
        floating.innerHTML = `${event.critical ? '<small>暴击 ×1.5</small>' : ''}<b>−${number(event.damage)}</b>`;
        requireElement(defender, '.damage-zone').append(floating);
        this.appendEvent(event, battle);
        if (event.hpAfter[event.defender] === 0) { defender.classList.add('defeated'); board.classList.add('knockout'); }
      });
    } finally {
      attacker.classList.remove('casting'); defender.classList.remove('hit', 'critical-hit'); skill?.classList.remove('active');
      this.playingAttack = false;
      if (!signal.aborted) this.updateSkipButton();
    }
  }
  private applyHp(hp: Readonly<Record<Side, number>>, log: BattleState): void {
    for (const side of ['left', 'right'] as const) {
      const value = hp[side];
      requireElement(this.root, `#hp-${side}`).textContent = value > 0 && value < 0.1 ? '< 0.1' : number(value);
      requireElement(this.root, `#bar-${side}`).style.transform = `scaleX(${Math.max(0, value / log.players[side].hp)})`;
      const track = requireElement(this.root, `#fighter-${side} .health-track`);
      track.setAttribute('aria-valuenow', String(value));
      track.setAttribute('aria-valuetext', `${number(value)} / ${number(log.players[side].hp)}`);
    }
  }

  private appendEvent(event: BattleEvent, log: Pick<BattleLog, 'players'>): void {
    const item = document.createElement('li');
    item.className = `log-event ${event.attacker}`;
    item.innerHTML = `<span class="log-round">${String(event.round).padStart(2, '0')}</span><span><b>${escape(log.players[event.attacker].username)}</b> 使用 ${escape(event.skill.name)} ${event.critical ? '<em>暴击</em>' : ''}</span><strong>−${number(event.damage)}</strong>`;
    const list = requireElement(this.root, '#battle-log');
    list.append(item); list.scrollTop = list.scrollHeight;
  }

  private renderResult(log: BattleLog): void {
    const winner = log.winner === 'draw' ? '势均力敌，平局！' : `${log.players[log.winner].username} 获胜！`;
    const modeLabel = log.controlledSide ? `玩家对战 · 你操控 @${log.players[log.controlledSide].username}` : '自动观战';
    requireElement(this.root, '#screen').innerHTML = `<section class="result-screen"><div class="result-title"><span class="result-emblem">${bolt}</span><span class="eyebrow">MATCH COMPLETE</span><h1>${escape(winner)}</h1><p>${log.reason === 'knockout' ? 'K.O.！以代码实力击倒对手。' : '30 回合结束，按剩余 HP 比例判定。'}</p><span class="seed-badge mono">SEED ${log.seed}</span></div>
      <p class="result-mode mono">${escape(modeLabel)} · 选招与伤害已记录</p><div class="result-stats"><div><span>总回合数</span><strong>${log.summary.rounds}<small> / 30</small></strong></div><div><span>最高单次伤害</span><strong>${number(log.summary.highestDamage)}</strong></div><div><span>MVP 技能</span><strong class="mvp-name">${escape(log.summary.mvp.skill)}</strong><small>@${escape(log.players[log.summary.mvp.side].username)} · 有效伤害 ${number(log.summary.mvp.damage)}</small></div></div>
      <div class="result-preview"><div class="preview-top"><span class="eyebrow">YOUR BATTLE CARD</span><span>PNG · 1200 × 630</span></div><div id="canvas-preview" role="status"><div class="canvas-loading"><span class="spinner"></span> 正在生成分享图…</div></div><p id="canvas-message" role="status" hidden></p></div>
      <div class="result-actions"><button id="download-card" class="button primary" disabled>下载结果图 ${arrow}</button><button id="replay" class="button secondary">↻ 重播本局</button><button id="rematch" class="button secondary">再来一局</button><button id="result-config" class="text-button">返回配置</button></div><button id="retry-card" class="text-button retry-card" hidden>重新生成分享图</button>
      <details class="result-log"><summary>查看完整战报 <span>${log.summary.rounds} 回合</span></summary><ol id="battle-log" aria-label="完整战报"></ol></details></section>`;
    for (const event of log.events) this.appendEvent(event, log);
    requireElement(this.root, '#replay').addEventListener('click', () => this.transition({ screen: 'battle', battle: createBattle(log.players.left, log.players.right, log.seed, log), replay: log }));
    requireElement(this.root, '#rematch').addEventListener('click', () => {
      const now = Date.now();
      const seed = now === log.seed ? log.seed === Number.MAX_SAFE_INTEGER ? 0 : log.seed + 1 : now;
      this.transition({ screen: 'battle', battle: createBattle(log.players.left, log.players.right, seed, log) });
    });
    requireElement(this.root, '#result-config').addEventListener('click', () => this.transition({ screen: 'config' }));
    requireElement(this.root, '#retry-card').addEventListener('click', () => { void this.generateCard(log); });
    requireElement(this.root, '#download-card').addEventListener('click', () => {
      if (!this.canvas) return;
      try { downloadResultCard(this.canvas, log); this.cardMessage('PNG 已准备下载。', false); }
      catch (error: unknown) { this.cardMessage(error instanceof Error ? error.message : '下载失败，请重试。', true); }
    });
    requireElement(this.root, '#main').focus();
    void this.generateCard(log);
  }

  private cardMessage(message: string, retry: boolean): void {
    const element = requireElement(this.root, '#canvas-message');
    element.hidden = false; element.textContent = message;
    requireElement<HTMLButtonElement>(this.root, '#retry-card').hidden = !retry;
  }

  private async generateCard(log: BattleLog): Promise<void> {
    const revision = ++this.canvasRevision;
    const button = requireElement<HTMLButtonElement>(this.root, '#download-card');
    button.disabled = true;
    requireElement<HTMLButtonElement>(this.root, '#retry-card').hidden = true;
    requireElement(this.root, '#canvas-message').hidden = true;
    try {
      const canvas = await renderResultCard(log);
      if (revision !== this.canvasRevision || this.state.screen !== 'result') return;
      canvas.toDataURL('image/png');
      this.canvas = canvas;
      requireElement(this.root, '#canvas-preview').replaceChildren(canvas);
      button.disabled = false;
      if (canvas.dataset.missingAvatars === 'true') this.cardMessage('部分头像加载失败，已使用占位头像。可下载，也可重新生成。', true);
    } catch (error: unknown) {
      if (revision !== this.canvasRevision || this.state.screen !== 'result') return;
      requireElement(this.root, '#canvas-preview').textContent = '分享图暂未生成。';
      this.cardMessage(error instanceof Error ? error.message : '生成分享图失败，请重试。', true);
    }
  }
}
