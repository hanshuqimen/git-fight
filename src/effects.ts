import type { BattleEvent, PlayerStats, Side } from './types';

export type EffectFamily = 'prism' | 'electric' | 'ember' | 'vortex' | 'pulse';
export function effectFamily(name: string): EffectFamily {
  if (['TypeScript', 'C#', 'Swift'].includes(name)) return 'prism';
  if (['JavaScript', 'Go', 'Java'].includes(name)) return 'electric';
  if (['Rust', 'C', 'C++'].includes(name)) return 'ember';
  if (['Python', 'Ruby', 'PHP'].includes(name)) return 'vortex';
  return 'pulse';
}

/** One cancellable presentation clock; pausing never changes battle RNG or state. */
export class PresentationClock {
  paused = false;
  private skipRequested = false;
  skip(): void { this.skipRequested = true; }

  animate(duration: number, signal: AbortSignal, update: (progress: number) => void): Promise<void> {
    this.skipRequested = false;
    return new Promise(resolve => {
      let frame = 0; let elapsed = 0; let last = performance.now(); let done = false;
      const finish = (): void => {
        if (done) return;
        done = true; cancelAnimationFrame(frame); signal.removeEventListener('abort', finish); resolve();
      };
      const tick = (now: number): void => {
        if (signal.aborted) { finish(); return; }
        if (!this.paused) elapsed += Math.min(100, now - last);
        last = now;
        if (this.skipRequested) elapsed = duration;
        update(Math.min(1, elapsed / duration));
        if (elapsed >= duration) finish(); else frame = requestAnimationFrame(tick);
      };
      if (signal.aborted) finish();
      else { signal.addEventListener('abort', finish, { once: true }); frame = requestAnimationFrame(tick); }
    });
  }
}

interface Point { x: number; y: number }
interface Spark { angle: number; distance: number; size: number }
const accents: Record<Side, string> = { left: '#5ce8f5', right: '#ff985c' };

export class BattleEffects {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly resize: ResizeObserver;
  private width = 0;
  private height = 0;
  private ratio = 1;
  private event: BattleEvent | null = null;
  private points: Record<Side, Point> = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  private readonly cutin: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly sparks: Spark[] = [];

  constructor(private readonly board: HTMLElement, private readonly clock: PresentationClock, private readonly reduced: () => boolean) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'effects-canvas'; this.canvas.setAttribute('aria-hidden', 'true');
    board.append(this.canvas); this.ctx = this.canvas.getContext('2d');
    this.cutin = board.querySelector<HTMLElement>('.critical-cutin')!;
    this.banner = board.querySelector<HTMLElement>('.attack-banner')!;
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(board); this.measure();
  }

  private measure(): void {
    const rect = this.board.getBoundingClientRect();
    this.width = rect.width; this.height = rect.height;
    this.ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.ratio); this.canvas.height = Math.round(this.height * this.ratio);
    this.ctx?.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    for (const side of ['left', 'right'] as const) {
      const avatar = this.board.querySelector<HTMLElement>(`#fighter-${side} .avatar`);
      if (avatar) { const box = avatar.getBoundingClientRect(); this.points[side] = { x: box.x + box.width / 2 - rect.x, y: box.y + box.height / 2 - rect.y }; }
    }
  }

  async play(event: BattleEvent, players: Readonly<Record<Side, PlayerStats>>, seed: number, duration: number, signal: AbortSignal, impact: () => void): Promise<void> {
    this.event = event; this.measure(); this.sparks.length = 0;
    // Separate deterministic effect stream; never advances the battle generator.
    let visual = (seed ^ Math.imul(event.round, 2654435761)) >>> 0;
    const random = (): number => { visual = (Math.imul(visual, 1664525) + 1013904223) >>> 0; return visual / 4294967296; };
    for (let i = 0; i < (event.critical ? 96 : 48); i++) this.sparks.push({ angle: random() * Math.PI * 2, distance: 45 + random() * 180, size: 1 + random() * 3 });
    this.board.dataset.family = effectFamily(event.skill.name);
    this.board.dataset.attacker = event.attacker;
    this.board.style.setProperty('--attack-duration', `${duration}ms`);
    this.banner.querySelector('strong')!.textContent = event.skill.name;
    this.banner.querySelector('span')!.textContent = `@${players[event.attacker].username} · ${event.chosenBy === 'player' ? '你的攻击' : '程序出招'}`;
    this.cutin.querySelector('span')!.textContent = `@${players[event.attacker].username}`;
    let phase = ''; let impacted = false;
    try {
      await this.clock.animate(duration, signal, progress => {
        const next = progress < .26 ? 'charge' : progress < .42 ? 'travel' : progress < .76 ? 'impact' : 'settle';
        if (next !== phase) {
          phase = next; this.board.dataset.phase = phase;
          this.board.classList.toggle('critical-window', event.critical && phase === 'travel');
          this.board.classList.toggle('critical-impact', event.critical && phase === 'impact');
        }
        if (!impacted && progress >= .42) { impacted = true; impact(); }
        this.draw(progress);
      });
    } finally { this.clear(); }
  }

  private draw(progress: number): void {
    const ctx = this.ctx; const event = this.event;
    if (!ctx || !event) return;
    ctx.clearRect(0, 0, this.width, this.height);
    if (this.reduced() || progress >= 1) return;
    const start = this.points[event.attacker]; const end = this.points[event.defender];
    const color = accents[event.attacker]; const family = effectFamily(event.skill.name);
    ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 14;
    if (progress < .42) {
      const power = Math.min(1, progress / .26);
      for (let ring = 0; ring < 3; ring++) {
        ctx.globalAlpha = .25 + power * .5; ctx.lineWidth = ring === 0 ? 2 : 1;
        ctx.beginPath(); ctx.arc(start.x, start.y, 48 + ring * 13 + Math.sin(progress * 24 + ring) * 4, progress * 10 + ring, progress * 10 + ring + Math.PI * 1.6); ctx.stroke();
      }
      if (progress >= .26) {
        const travel = (progress - .26) / .16;
        const x = start.x + (end.x - start.x) * travel; const y = start.y + (end.y - start.y) * travel - Math.sin(travel * Math.PI) * 35;
        ctx.lineWidth = event.critical ? 7 : 4;
        ctx.beginPath(); ctx.moveTo(start.x, start.y);
        if (family === 'electric') {
          for (let i = 1; i < 9; i++) ctx.lineTo(start.x + (x - start.x) * i / 9, start.y + (y - start.y) * i / 9 + Math.sin(i * 7 + progress * 60) * 13);
          ctx.lineTo(x, y);
        } else ctx.quadraticCurveTo((start.x + x) / 2, (start.y + y) / 2 - 35, x, y);
        ctx.stroke(); ctx.fillStyle = '#eaffff';
        ctx.beginPath();
        if (family === 'prism') { ctx.moveTo(x + 16, y); ctx.lineTo(x, y - 18); ctx.lineTo(x - 16, y); ctx.lineTo(x, y + 18); ctx.closePath(); }
        else ctx.arc(x, y, 12 + Math.sin(progress * 45) * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = 'bold 13px Consolas, monospace'; ctx.globalAlpha = .8;
        ctx.fillText(family === 'ember' ? '{ }' : family === 'vortex' ? '(λ)' : '</>', x - 12, y - 28);
      }
    } else {
      const age = (progress - .42) / .58;
      const eased = 1 - (1 - age) ** 3;
      ctx.globalAlpha = (1 - age) ** 2;
      for (let ring = 0; ring < 3; ring++) {
        ctx.lineWidth = (3 - ring) * (event.critical ? 2 : 1);
        ctx.beginPath(); ctx.ellipse(end.x, end.y, 15 + eased * (100 + ring * 44), 15 + eased * (85 + ring * 35), age * 2, 0, Math.PI * 2); ctx.stroke();
      }
      for (const spark of this.sparks) {
        const x = end.x + Math.cos(spark.angle) * spark.distance * eased;
        const y = end.y + Math.sin(spark.angle) * spark.distance * eased + age * age * 60;
        ctx.globalAlpha = Math.max(0, 1 - age * 1.3); ctx.lineWidth = spark.size;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - Math.cos(spark.angle) * 12 * (1 - age), y - Math.sin(spark.angle) * 12 * (1 - age)); ctx.stroke();
      }
      if (family === 'vortex') {
        ctx.beginPath(); for (let i = 0; i < 90; i++) { const angle = i / 7 + progress * 12; const radius = i * 1.4 * eased; const x = end.x + Math.cos(angle) * radius; const y = end.y + Math.sin(angle) * radius; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke();
      }
    }
    ctx.restore();
  }

  clear(): void {
    this.ctx?.clearRect(0, 0, this.width, this.height);
    delete this.board.dataset.phase; this.board.classList.remove('critical-window', 'critical-impact');
    this.board.querySelectorAll('.damage-number').forEach(element => element.remove());
    this.event = null;
  }

  dispose(): void { this.resize.disconnect(); this.clear(); this.canvas.remove(); }
}
