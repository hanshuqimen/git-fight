import type { AttackChoice, AvailableAction, BattleEvent, BattleLog, BattleOptions, BattleState, PlayerStats, Side, Skill } from './types';

const BASIC: Skill = { name: '普通攻击', count: 0, weight: 1, multiplier: 1 };

export function buildSkills(languages: Readonly<Record<string, number>>): readonly Skill[] {
  const selected = Object.entries(languages).filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort(([a, ac], [b, bc]) => bc - ac || (a < b ? -1 : a > b ? 1 : 0)).slice(0, 3);
  if (selected.length === 0) return [{ ...BASIC }];
  const mean = selected.reduce((total, [, count]) => total + count, 0) / selected.length;
  return selected.map(([name, count]) => ({ name, count, weight: count, multiplier: Math.max(1, count / mean) }));
}

export function validateSeed(seed: number): void {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Seed 必须是非负安全整数。');
}

function initialRandomState(seed: number): number {
  let state = 2166136261;
  for (const char of String(seed)) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return state;
}

// Explicit Mulberry32 state makes incremental turns as deterministic as full simulation.
function draw(state: number): { state: number; value: number } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let value = Math.imul(next ^ (next >>> 15), 1 | next);
  value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
  return { state: next, value: ((value ^ (value >>> 14)) >>> 0) / 4294967296 };
}

function validatePlayer(player: PlayerStats): void {
  if (!Number.isFinite(player.hp) || player.hp <= 0 || !Number.isFinite(player.atk) || player.atk <= 0) throw new Error('角色 HP 和 ATK 必须为正数。');
  if (player.skills.length === 0 || player.skills.some(skill => !Number.isFinite(skill.weight) || skill.weight <= 0 || !Number.isFinite(skill.multiplier) || skill.multiplier < 1)) throw new Error('技能权重必须为正数，倍率必须至少为 1。');
}

export function createBattle(left: PlayerStats, right: PlayerStats, seed: number, options: BattleOptions = { mode: 'auto', controlledSide: null }): BattleState {
  validateSeed(seed); validatePlayer(left); validatePlayer(right);
  if (options.mode !== 'auto' && options.mode !== 'interactive') throw new Error('未知对战模式。');
  if (options.mode === 'interactive' && options.controlledSide !== 'left' && options.controlledSide !== 'right') throw new Error('手动模式需要选择操控方。');
  return {
    seed, mode: options.mode, controlledSide: options.mode === 'auto' ? null : options.controlledSide,
    players: structuredClone({ left, right }), hp: { left: left.hp, right: right.hp },
    attacker: left.atk >= right.atk ? 'left' : 'right', randomState: initialRandomState(seed),
    cooldowns: { left: left.skills.map(() => 0), right: right.skills.map(() => 0) }, events: [], complete: false,
  };
}

export function getAvailableActions(state: BattleState, side: Side = state.attacker): readonly AvailableAction[] {
  return [
    { choice: { kind: 'basic' }, skill: BASIC, available: !state.complete, cooldown: 0 },
    ...state.players[side].skills.flatMap((skill, index): AvailableAction[] => skill.count > 0 ? [{
      choice: { kind: 'skill', index }, skill, cooldown: state.cooldowns[side][index] ?? 0,
      available: !state.complete && (state.cooldowns[side][index] ?? 0) === 0,
    }] : []),
  ];
}

function sameChoice(a: AttackChoice, b: AttackChoice): boolean {
  return a.kind === b.kind && (a.kind === 'basic' || b.kind === 'skill' && a.index === b.index);
}

/** A player command includes the expected round, rejecting stale/double submissions. */
export function resolveTurn(state: BattleState, command?: { readonly round: number; readonly choice: AttackChoice }): BattleState {
  if (state.complete) throw new Error('对战已经结束。');
  const playerTurn = state.mode === 'interactive' && state.attacker === state.controlledSide;
  if (playerTurn && !command) throw new Error('请选择本回合攻击。');
  if (!playerTurn && command) throw new Error('当前不是玩家回合。');
  const round = state.events.length + 1;
  if (command && command.round !== round) throw new Error('该操作已过期，请重新选择。');
  const actions = getAvailableActions(state).filter(action => action.available);
  let selected = command ? actions.find(action => sameChoice(action.choice, command.choice)) : undefined;
  if (command && !selected) throw new Error('该技能不存在或正在冷却。');
  const skillRoll = draw(state.randomState);
  const variationRoll = draw(skillRoll.state);
  const criticalRoll = draw(variationRoll.state);
  if (!selected) {
    const languages = actions.filter(action => action.choice.kind === 'skill');
    const pool = languages.length ? languages : actions;
    let cursor = skillRoll.value * pool.reduce((sum, action) => sum + action.skill.weight, 0);
    selected = pool[0];
    for (const action of pool) { cursor -= action.skill.weight; if (cursor < 0) { selected = action; break; } }
  }
  if (!selected) throw new Error('角色没有可用攻击。');
  const attacker = state.attacker;
  const defender: Side = attacker === 'left' ? 'right' : 'left';
  const variation = 0.8 + variationRoll.value * 0.4;
  const critical = criticalRoll.value < 0.15;
  const damage = state.players[attacker].atk * selected.skill.multiplier * variation * (critical ? 1.5 : 1);
  const effectiveDamage = Math.min(state.hp[defender], damage);
  const hp = { ...state.hp, [defender]: Math.max(0, state.hp[defender] - damage) };
  const cooldown = state.cooldowns[attacker].map(value => Math.max(0, value - 1));
  if (selected.choice.kind === 'skill') cooldown[selected.choice.index] = 1;
  const event: BattleEvent = { round, attacker, defender, skill: { ...selected.skill }, action: { ...selected.choice }, chosenBy: playerTurn ? 'player' : 'ai', variation, critical, damage, effectiveDamage, hpAfter: hp };
  return { ...state, hp, attacker: defender, randomState: criticalRoll.state,
    cooldowns: { ...state.cooldowns, [attacker]: cooldown }, events: [...state.events, event], complete: hp[defender] === 0 || round === 30 };
}

export function finishBattle(state: BattleState): BattleLog {
  if (!state.complete) throw new Error('对战尚未结束。');
  const knockedOut = state.hp.left === 0 || state.hp.right === 0;
  const comparison = state.hp.left / state.players.left.hp - state.hp.right / state.players.right.hp;
  const winner: BattleLog['winner'] = comparison > 0 ? 'left' : comparison < 0 ? 'right' : 'draw';
  const totals = new Map<string, { side: Side; skill: string; damage: number }>();
  for (const event of state.events) {
    const key = `${event.attacker}:${event.skill.name}`;
    const total = totals.get(key);
    if (total) total.damage += event.effectiveDamage;
    else totals.set(key, { side: event.attacker, skill: event.skill.name, damage: event.effectiveDamage });
  }
  let mvp = { side: 'left' as Side, skill: BASIC.name, damage: 0 };
  for (const total of totals.values()) if (total.damage > mvp.damage) mvp = { ...total };
  return structuredClone({ seed: state.seed, mode: state.mode, controlledSide: state.controlledSide,
    players: state.players, events: state.events, finalHp: state.hp, winner, reason: knockedOut ? 'knockout' : 'round-limit',
    summary: { rounds: state.events.length, highestDamage: Math.max(...state.events.map(event => event.damage)), mvp } });
}

export function simulateBattle(left: PlayerStats, right: PlayerStats, seed: number): BattleLog {
  let state = createBattle(left, right, seed);
  while (!state.complete) state = resolveTurn(state);
  return finishBattle(state);
}

