/**
 * A seeded generator, so the demo is the same demo every night.
 *
 * CLAUDE.md §8 wants the demo tenant deterministic. `Math.random` would give a
 * different school on every reset — different marks, different arrears, a
 * different child at the bottom of the class — and a presenter who rehearsed
 * against yesterday's data would be reading from the wrong script. Worse, a
 * bug that only shows up for one arrangement of the data would appear and
 * disappear between runs.
 *
 * mulberry32: small, fast, and good enough for names and marks. Not for
 * anything that needs to be unguessable — the callback tokens come from
 * `crypto`, and deliberately not from here.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6D2B79F5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** A copy, shuffled — the input is left alone. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  /**
   * Roughly normal, clamped — for marks.
   *
   * A uniform distribution makes a class where the top and bottom are as
   * crowded as the middle, which no teacher looking at the screen would
   * believe. Three samples averaged is close enough to a bell for this, and
   * cheap.
   */
  around(mean: number, spread: number, min: number, max: number): number {
    const sample = (this.next() + this.next() + this.next()) / 3;
    const value = mean + (sample - 0.5) * 2 * spread;
    return Math.max(min, Math.min(max, Math.round(value)));
  }
}
