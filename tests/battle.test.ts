import { describe, expect, it } from 'vitest';
import { buildSkills, createBattle, finishBattle, getAvailableActions, resolveTurn, simulateBattle } from '../src/battle';
import type { PlayerStats } from '../src/types';

export function player(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return { username: 'octocat', name: 'Octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/1', publicRepos: 0, followers: 0, stars: 0, commits: 0, hp: 100, atk: 10, skills: buildSkills({}), commitSource: 'search', repositoriesCounted: 0, truncated: false, ...overrides };
}

describe('skills', () => {
  it('provides a normal attack for empty language data', () => expect(buildSkills({})[0]).toMatchObject({ multiplier: 1, weight: 1 }));
  it('normalizes top three counts against their mean and uses counts as weights', () => {
    const skills = buildSkills({ Z: 1, Python: 6, Rust: 3, Go: 1, C: 1 });
    expect(skills.map(skill => skill.name)).toEqual(['Python', 'Rust', 'C']);
    expect(skills[0]?.multiplier).toBeCloseTo(1.8);
    expect(skills[0]?.weight).toBe(6);
    expect(skills.slice(1).map(skill => skill.multiplier)).toEqual([1, 1]);
  });
});

describe('interactive turns', () => {
  const fighter = (): PlayerStats => player({ hp: 10000, skills: buildSkills({ TypeScript: 8, Rust: 2, Python: 1 }) });
  const manual = () => createBattle(fighter(), fighter(), 42, { mode: 'interactive', controlledSide: 'left' });
  it('blocks a used language for exactly the next personal turn', () => {
    let state = resolveTurn(manual(), { round: 1, choice: { kind: 'skill', index: 0 } });
    state = resolveTurn(state);
    expect(getAvailableActions(state)[1]).toMatchObject({ available: false, cooldown: 1 });
    expect(() => resolveTurn(state, { round: 3, choice: { kind: 'skill', index: 0 } })).toThrow();
    expect(getAvailableActions(state)[0]?.available).toBe(true);
    state = resolveTurn(state, { round: 3, choice: { kind: 'basic' } });
    state = resolveTurn(state);
    expect(getAvailableActions(state)[1]).toMatchObject({ available: true, cooldown: 0 });
  });
  it('rejects missing, stale, duplicate, invalid and out-of-turn commands without mutation', () => {
    const state = manual(); const copy = structuredClone(state);
    expect(() => resolveTurn(state)).toThrow();
    expect(() => resolveTurn(state, { round: 0, choice: { kind: 'basic' } })).toThrow();
    expect(() => resolveTurn(state, { round: 1, choice: { kind: 'skill', index: 99 } })).toThrow();
    const next = resolveTurn(state, { round: 1, choice: { kind: 'basic' } });
    expect(() => resolveTurn(next, { round: 1, choice: { kind: 'basic' } })).toThrow();
    expect(() => finishBattle(state)).toThrow();
    expect(state).toEqual(copy);
  });
  it('does not shift damage rolls when a human replaces the weighted skill roll', () => {
    const ai = resolveTurn(createBattle(fighter(), fighter(), 42));
    const human = resolveTurn(manual(), { round: 1, choice: { kind: 'basic' } });
    expect(ai.randomState).toBe(human.randomState);
    expect(ai.events[0]?.variation).toBe(human.events[0]?.variation);
    expect(ai.events[0]?.critical).toBe(human.events[0]?.critical);
  });
  it('reproduces a manual battle from seed, snapshots and recorded selections', () => {
    let state = manual();
    while (!state.complete) state = state.attacker === 'left'
      ? resolveTurn(state, { round: state.events.length + 1, choice: getAvailableActions(state).find(a => a.available && a.choice.kind === 'skill')?.choice ?? { kind: 'basic' } })
      : resolveTurn(state);
    const log = finishBattle(state);
    let replay = manual();
    for (const event of log.events) replay = resolveTurn(replay, event.chosenBy === 'player' ? { round: event.round, choice: event.action } : undefined);
    expect(finishBattle(replay)).toEqual(log);
    expect(log.mode).toBe('interactive');
    expect(log.controlledSide).toBe('left');
  });
  it('automated turns match full simulation and never use a cooling skill', () => {
    let state = createBattle(fighter(), fighter(), 71);
    while (!state.complete) {
      const actions = getAvailableActions(state);
      state = resolveTurn(state);
      const event = state.events.at(-1);
      expect(actions.find(a => a.choice.kind === event?.action.kind && (a.choice.kind === 'basic' || event?.action.kind === 'skill' && a.choice.index === event.action.index))?.available).toBe(true);
    }
    expect(finishBattle(state)).toEqual(simulateBattle(fighter(), fighter(), 71));
    expect(() => resolveTurn(state)).toThrow();
  });
  it('AI keeps weighted language sampling and falls back to basic on cooldown', () => {
    const heavy = player({ skills: buildSkills({ Big: 100, Small: 1 }), hp: 10000 });
    let big = 0;
    for (let seed = 0; seed < 150; seed++) if (resolveTurn(createBattle(heavy, fighter(), seed)).events[0]?.skill.name === 'Big') big++;
    expect(big).toBeGreaterThan(140);
    const solo = player({ hp: 10000, skills: buildSkills({ C: 1 }) });
    let state = createBattle(solo, solo, 0);
    state = resolveTurn(resolveTurn(resolveTurn(state)));
    expect(state.events[2]?.action.kind).toBe('basic');
  });
  it('supports controlling right and a no-language player', () => {
    let state = createBattle(player(), player(), 0, { mode: 'interactive', controlledSide: 'right' });
    expect(() => resolveTurn(state, { round: 1, choice: { kind: 'basic' } })).toThrow();
    state = resolveTurn(state);
    expect(getAvailableActions(state)).toHaveLength(1);
    expect(resolveTurn(state, { round: 2, choice: { kind: 'basic' } }).events[1]?.chosenBy).toBe('player');
  });
});

describe('battle', () => {
  it('zero stars/commits can fight with no language', () => {
    const log = simulateBattle(player(), player(), 0);
    expect(log.events.length).toBeGreaterThan(0);
    expect(log.events.length).toBeLessThanOrEqual(30);
    expect(log.events.every(event => event.hpAfter.left >= 0 && event.hpAfter.right >= 0)).toBe(true);
  });
  it('is deterministic including Date.now-sized seeds and preserves inputs', () => {
    const left = player({ skills: buildSkills({ TypeScript: 10, Rust: 3 }) });
    const before = structuredClone(left);
    const one = simulateBattle(left, player(), 1791060000000);
    expect(one).toEqual(simulateBattle(left, player(), 1791060000000));
    expect(left).toEqual(before);
    expect(one.players.left).not.toBe(left);
    expect(one).not.toEqual(simulateBattle(left, player(), 1791060000001));
  });
  it('higher ATK goes first, with left winning a tie', () => {
    expect(simulateBattle(player(), player({ atk: 11 }), 8).events[0]?.attacker).toBe('right');
    expect(simulateBattle(player(), player(), 8).events[0]?.attacker).toBe('left');
  });
  it('ends immediately on knockout and records overkill separately', () => {
    const log = simulateBattle(player({ atk: 1000 }), player(), 0);
    expect(log.summary.rounds).toBe(1);
    expect(log.winner).toBe('left');
    expect(log.reason).toBe('knockout');
    expect(log.finalHp.right).toBe(0);
    expect(log.events[0]?.effectiveDamage).toBe(100);
    expect(log.summary.highestDamage).toBeGreaterThan(100);
  });
  it('converges at 30 turns and compares percentages rather than absolute HP', () => {
    const log = simulateBattle(player({ hp: 10000 }), player({ hp: 1000000 }), 42);
    expect(log.events).toHaveLength(30);
    expect(log.reason).toBe('round-limit');
    expect(log.winner).toBe('right');
  });
  it('declares exact equal remaining percentages a draw', () => {
    const log = simulateBattle(player({ hp: 1e30 }), player({ hp: 1e30 }), 42);
    expect(log.events).toHaveLength(30);
    expect(log.winner).toBe('draw');
  });
  it('follows the damage formula and chooses MVP using effective damage', () => {
    const log = simulateBattle(player({ skills: buildSkills({ TypeScript: 8, Rust: 1, Python: 1 }) }), player(), 7);
    for (const event of log.events) {
      expect(event.variation).toBeGreaterThanOrEqual(0.8);
      expect(event.variation).toBeLessThan(1.2);
      expect(event.damage).toBe(log.players[event.attacker].atk * event.skill.multiplier * event.variation * (event.critical ? 1.5 : 1));
    }
    const total = log.events.filter(event => event.attacker === log.summary.mvp.side && event.skill.name === log.summary.mvp.skill).reduce((sum, event) => sum + event.effectiveDamage, 0);
    expect(log.summary.mvp.damage).toBe(total);
  });
  it('rejects invalid seeds and player data', () => {
    for (const seed of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => simulateBattle(player(), player(), seed)).toThrow();
    expect(() => simulateBattle(player({ hp: 0 }), player(), 0)).toThrow();
  });
});
