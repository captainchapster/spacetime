import { describe, expect, it } from 'vitest';
import { decayBrake, iscoRadius, polarIsso } from '../src/physics/disk';
import { inner } from '../src/physics/linalg';
import { Kerr } from '../src/physics/metrics/kerr';
import { lockDirection } from '../src/physics/nav';
import { Ship } from '../src/physics/ship';

/**
 * The "decaying orbit" starts, as in the game: a prograde orbit at ISCO + 6M, a few degrees
 * out of the disk plane (or a polar orbit at the polar ISSO + 6M), braked gently against its
 * motion down to that innermost stable orbit; from there on it falls freely.
 */
export function decayingOrbit(a: number, turns: number, polar = false) {
  const hole = new Kerr(1, a);
  const isco = polar ? polarIsso(a) : iscoRadius(a);
  const r0 = isco + 6;
  const A = polar ? decayBrake(0, 12, turns) : decayBrake(a, r0, turns);
  const th = ((polar ? 90 : 85) * Math.PI) / 180;
  const R = Math.sqrt(r0 * r0 + a * a);
  const pos: [number, number, number] = [0, -R * Math.sin(th), r0 * Math.cos(th)];
  const om = 1 / (r0 ** 1.5 + a);
  const vel: [number, number, number] = polar ? [0, 0, Math.sqrt(1 / r0)] : [-om * pos[1], om * pos[0], 0];
  const ship = new Ship(hole, pos, vel, [0, 1, 0], [0, 0, 1]);
  const brake = (s: Ship): [number, number, number] => {
    if (hole.radius(s.x) <= isco) return [0, 0, 0];
    const d = lockDirection(hole, s, 'retrograde', undefined, 'zamo');
    if (!d) return [0, 0, 0];
    const g = hole.metric(s.x);
    const c = s.e.map((e) => inner(g, d, e));
    const n = Math.hypot(...c);
    return c.map((q) => (A * q) / n) as [number, number, number];
  };
  // Turns: the angle swept by the position vector (the orbital plane may precess).
  let prev = [ship.x[1], ship.x[2], ship.x[3]];
  let wound = 0;
  let toIsco = -1;
  while (!ship.crushed && hole.radius(ship.x) > hole.horizonRadius && ship.tau < 50000) {
    ship.step(hole, 0.2, brake, 400);
    const cur = [ship.x[1], ship.x[2], ship.x[3]];
    const cos = (prev[0] * cur[0] + prev[1] * cur[1] + prev[2] * cur[2]) / (Math.hypot(...prev) * Math.hypot(...cur));
    wound += Math.acos(Math.max(-1, Math.min(1, cos))) / (2 * Math.PI);
    prev = cur;
    if (toIsco < 0 && hole.radius(ship.x) <= isco) toIsco = wound;
  }
  return { toIsco, total: wound, crossed: hole.radius(ship.x) <= hole.horizonRadius || ship.crushed };
}

describe('a decaying orbit', () => {
  it('winds down to the ISCO in about the asked-for number of turns, at any spin, then plunges', () => {
    for (const a of [0.95, 0.8, 0.5, 0]) {
      const { toIsco, total, crossed } = decayingOrbit(a, 10);
      expect(toIsco).toBeGreaterThan(7);
      expect(toIsco).toBeLessThan(13);
      expect(total).toBeGreaterThan(toIsco); // the free spiral after the ISCO adds turns
      expect(crossed).toBe(true);
    }
  });

  it('finds the innermost stable polar orbit: 6M without spin, about 5.27M at the extreme', () => {
    expect(polarIsso(0)).toBeCloseTo(6, 6);
    // Extremal Kerr: 1 + √3 + √(3 + 2√3) ≈ 5.2745 (polar orbits feel no spin-orbit boost).
    expect(polarIsso(0.99999)).toBeCloseTo(1 + Math.sqrt(3) + Math.sqrt(3 + 2 * Math.sqrt(3)), 2);
    expect(polarIsso(0.95)).toBeGreaterThan(iscoRadius(0.95)); // well outside the prograde ISCO
  });

  it('winds a polar orbit down over the poles in about the asked-for number of turns', () => {
    for (const a of [0.95, 0.5, 0]) {
      const { toIsco, total, crossed } = decayingOrbit(a, 10, true);
      expect(toIsco).toBeGreaterThan(8);
      expect(toIsco).toBeLessThan(13);
      expect(total).toBeGreaterThan(toIsco);
      expect(crossed).toBe(true);
    }
  });
});
