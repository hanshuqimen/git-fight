import type { BattleLog, PlayerStats, Side } from './types';

const COLORS = { background: '#080e17', panel: '#112334', text: '#edf6ff', muted: '#9aafc5', left: '#5ce8f5', right: '#ff985c' };
const FONT = '"Segoe UI", "Microsoft YaHei", sans-serif';

export function safeAvatarUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'avatars.githubusercontent.com' ? url.href : '';
  } catch { return ''; }
}

async function avatar(url: string): Promise<HTMLImageElement | null> {
  const source = safeAvatarUrl(url);
  if (!source) return null;
  return new Promise(resolve => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    let done = false;
    const finish = (value: HTMLImageElement | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), 10_000);
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = source;
  });
}

function label(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size: number, color: string = COLORS.text, weight = 400): void {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillText(value, x, y);
}

function fit(ctx: CanvasRenderingContext2D, value: string, width: number): string {
  if (ctx.measureText(value).width <= width) return value;
  const chars = Array.from(value);
  while (chars.length && ctx.measureText(`${chars.join('')}…`).width > width) chars.pop();
  return `${chars.join('')}…`;
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function fighter(ctx: CanvasRenderingContext2D, player: PlayerStats, side: Side, remaining: number, image: HTMLImageElement | null, log: BattleLog): void {
  const x = side === 'left' ? 52 : 652;
  const accent = COLORS[side];
  const tint = ctx.createLinearGradient(x, 172, x + 496, 466);
  tint.addColorStop(0, side === 'left' ? '#17394b' : '#392a24');
  tint.addColorStop(1, COLORS.panel);
  ctx.fillStyle = tint;
  rounded(ctx, x, 172, 496, 294, 18);
  ctx.fillStyle = accent;
  rounded(ctx, x, 172, 496, 4, 2);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + 64, 239, 36, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#30394a';
  ctx.fillRect(x + 28, 203, 72, 72);
  if (image) ctx.drawImage(image, x + 28, 203, 72, 72);
  else label(ctx, player.username.slice(0, 1).toUpperCase(), x + 52, 253, 36, accent, 700);
  ctx.restore();
  ctx.font = `700 27px ${FONT}`;
  label(ctx, fit(ctx, player.name, 324), x + 116, 234, 27, COLORS.text, 700);
  ctx.font = `400 17px ${FONT}`;
  label(ctx, fit(ctx, `@${player.username}`, 324), x + 116, 261, 17, COLORS.muted);
  label(ctx, `${log.winner === side ? 'WINNER' : log.winner === 'draw' ? 'DRAW' : 'CHALLENGER'}  /  ${log.controlledSide === side ? '玩家操控' : '程序 AI'}`, x + 28, 308, 13, accent, 700);
  label(ctx, `HP  ${remaining.toFixed(1)} / ${player.hp.toLocaleString('en-US')}`, x + 28, 340, 22, COLORS.text, 700);
  ctx.fillStyle = '#30394a';
  rounded(ctx, x + 28, 355, 440, 9, 4);
  const hpWidth = 440 * Math.max(0, Math.min(1, remaining / player.hp));
  if (hpWidth > 0) { ctx.fillStyle = accent; rounded(ctx, x + 28, 355, hpWidth, 9, 4); }
  label(ctx, `ATK ${player.atk.toLocaleString('en-US')}    STAR ${player.stars.toLocaleString('en-US')}`, x + 28, 398, 18, COLORS.muted);
  ctx.font = `400 15px ${FONT}`;
  label(ctx, fit(ctx, player.skills.map(skill => `${skill.name} ${skill.multiplier.toFixed(2)}×`).join('  /  '), 440), x + 28, 432, 15, accent);
}

export async function renderResultCard(log: BattleLog): Promise<HTMLCanvasElement> {
  await document.fonts.ready;
  const [leftAvatar, rightAvatar] = await Promise.all([avatar(log.players.left.avatarUrl), avatar(log.players.right.avatarUrl)]);
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  canvas.dataset.missingAvatars = String(!leftAvatar || !rightAvatar);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `git-fight 对战结果，${log.winner === 'draw' ? '平局' : `${log.players[log.winner].username} 获胜`}，共 ${log.summary.rounds} 回合。`);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法创建 Canvas，请使用支持 Canvas 的浏览器重试。');
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, 1200, 630);
  const glow = ctx.createRadialGradient(600, 315, 0, 600, 315, 680);
  glow.addColorStop(0, '#1c415c'); glow.addColorStop(1, '#080e17');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, 1200, 630);
  ctx.strokeStyle = '#27465b';
  ctx.lineWidth = 1;
  for (let x = 0; x <= 1200; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 630); ctx.stroke(); }
  for (let y = 0; y <= 630; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1200, y); ctx.stroke(); }
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(36, 28, 1128, 118);
  label(ctx, 'git-fight', 52, 75, 34, COLORS.left, 800);
  label(ctx, `全息代码竞技场 / ${log.mode === 'interactive' ? '玩家对战' : '自动观战'}`, 52, 111, 16, COLORS.muted);
  const result = log.winner === 'draw' ? '势均力敌 · 平局' : `${log.players[log.winner].username} 获胜`;
  ctx.font = `700 28px ${FONT}`;
  const resultText = fit(ctx, result, 640);
  ctx.textAlign = 'right';
  label(ctx, resultText, 1148, 78, 28, COLORS.text, 700);
  label(ctx, log.reason === 'knockout' ? 'K.O. / 击倒获胜' : '30 回合 / 剩余 HP 比例判定', 1148, 110, 15, COLORS.muted);
  ctx.textAlign = 'left';
  fighter(ctx, log.players.left, 'left', log.finalHp.left, leftAvatar, log);
  fighter(ctx, log.players.right, 'right', log.finalHp.right, rightAvatar, log);
  ctx.strokeStyle = '#5ce8f54d'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(600, 315, 41, 61, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.textAlign = 'center';
  label(ctx, 'VS', 600, 326, 30, COLORS.muted, 800);
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.panel;
  rounded(ctx, 52, 486, 1096, 82, 12);
  label(ctx, '总回合', 76, 514, 13, COLORS.muted);
  label(ctx, String(log.summary.rounds), 76, 547, 24, COLORS.text, 700);
  label(ctx, '最高单次伤害', 284, 514, 13, COLORS.muted);
  label(ctx, log.summary.highestDamage.toFixed(1), 284, 547, 24, COLORS.text, 700);
  label(ctx, 'MVP 技能', 608, 514, 13, COLORS.muted);
  ctx.font = `700 22px ${FONT}`;
  label(ctx, fit(ctx, `${log.summary.mvp.skill} · @${log.players[log.summary.mvp.side].username}`, 510), 608, 547, 22, COLORS[log.summary.mvp.side], 700);
  label(ctx, `SEED ${log.seed}  ·  ${log.mode === 'interactive' ? '选招已记录' : '确定性自动战报'}`, 52, 602, 14, COLORS.muted);
  ctx.textAlign = 'right';
  const degraded = log.players.left.commitSource === 'repositories' || log.players.right.commitSource === 'repositories';
  label(ctx, degraded ? '公开 GitHub 数据 · 包含仓库提交降级统计' : '公开 GitHub 数据 · JUST FOR FUN', 1148, 602, 14, COLORS.muted);
  return canvas;
}

export function downloadResultCard(canvas: HTMLCanvasElement, log: BattleLog): void {
  try {
    const link = document.createElement('a');
    link.download = `git-fight-${log.players.left.username}-vs-${log.players.right.username}-${log.seed}.png`;
    link.href = canvas.toDataURL('image/png');
    document.body.append(link);
    link.click();
    link.remove();
  } catch { throw new Error('结果图导出失败，可能是头像跨域加载失败。请重新生成分享图后重试。'); }
}
