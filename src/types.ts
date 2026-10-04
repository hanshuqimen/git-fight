export type Side = 'left' | 'right';

export interface Skill {
  readonly name: string;
  readonly count: number;
  readonly weight: number;
  readonly multiplier: number;
}

export interface PlayerStats {
  readonly username: string;
  readonly name: string;
  readonly avatarUrl: string;
  readonly publicRepos: number;
  readonly followers: number;
  readonly stars: number;
  readonly commits: number;
  readonly hp: number;
  readonly atk: number;
  readonly skills: readonly Skill[];
  readonly commitSource: 'search' | 'repositories';
  readonly repositoriesCounted: number;
  readonly truncated: boolean;
}

export interface BattleEvent {
  readonly round: number;
  readonly attacker: Side;
  readonly defender: Side;
  readonly skill: Skill;
  readonly variation: number;
  readonly critical: boolean;
  readonly damage: number;
  readonly effectiveDamage: number;
  readonly hpAfter: Readonly<Record<Side, number>>;
  readonly action: AttackChoice;
  readonly chosenBy: 'player' | 'ai';
}

export type AttackChoice = { readonly kind: 'basic' } | { readonly kind: 'skill'; readonly index: number };
export type BattleMode = 'interactive' | 'auto';
export interface BattleOptions {
  readonly mode: BattleMode;
  readonly controlledSide: Side | null;
}
export interface AvailableAction {
  readonly choice: AttackChoice;
  readonly skill: Skill;
  readonly available: boolean;
  readonly cooldown: number;
}
export interface BattleState extends BattleOptions {
  readonly seed: number;
  readonly players: Readonly<Record<Side, PlayerStats>>;
  readonly hp: Readonly<Record<Side, number>>;
  readonly attacker: Side;
  readonly randomState: number;
  readonly cooldowns: Readonly<Record<Side, readonly number[]>>;
  readonly events: readonly BattleEvent[];
  readonly complete: boolean;
}

export interface BattleLog extends BattleOptions {
  readonly seed: number;
  readonly players: Readonly<Record<Side, PlayerStats>>;
  readonly events: readonly BattleEvent[];
  readonly finalHp: Readonly<Record<Side, number>>;
  readonly winner: Side | 'draw';
  readonly reason: 'knockout' | 'round-limit';
  readonly summary: {
    readonly rounds: number;
    readonly highestDamage: number;
    readonly mvp: { readonly side: Side; readonly skill: string; readonly damage: number };
  };
}
