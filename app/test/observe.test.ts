import { describe, expect, it } from 'vitest';
import { Kerr } from '../src/physics/metrics/kerr';
import { homeSignal, sampleView, sightBeacon, tidalAcceleration } from '../src/physics/observe';
import { navFrame, navState, worldToShip } from '../src/physics/nav';
import { Schwarzschild } from '../src/physics/metrics/schwarzschild';
import { Ship } from '../src/physics/ship';
import { World } from '../src/physics/world';
import { gravitationalRadius } from '../src/physics/units';

describe('what the ship observes', () => {
  it('sees the hole dead ahead when facing it, and sky behind', () => {
    const hole = new Kerr(1, 0.9);
    const ship = new Ship(hole, [0, -20, 0], [0, 0, 0], [0, 1, 0], [0, 0, 1]);
    expect(sampleView(hole, ship, 0, 0).kind).toBe('hole');
    const back = sampleView(hole, ship, 0, 0, true);
    expect(back.kind).toBe('sky');
    // A hovering observer at r sees starlight blueshifted by 1/√(−g_tt) (exactly so without spin).
    expect(back.g).toBeGreaterThan(1);
  });

  it('finds a beacon and reads the clock its arriving light left with (delayed, never ahead)', () => {
    const hole = new Kerr(1, 0);
    const ship = new Ship(hole, [0, -30, 0], [0, 0, 0], [0, 1, 0], [0, 0, 1]);
    const world = new World(hole);
    const beacon = world.addParticle([3, -20, 0], [0, 0, 0]); // 10M away, off to the side
    world.config.recordInterval = 0.05;
    world.advance(40);
    const at = (t: number) => {
      const s = [0, 0, 0, 0, 0];
      return beacon.sampleAt(t + world.time, s) ? { pos: [s[1], s[2], s[3]] as [number, number, number], u: beacon.u, tau: s[4] } : null;
    };
    ship.x[0] = 0; // the ray tracer measures time from "now"
    const seen = sightBeacon(hole, ship, beacon, at, 0.5, null);
    expect(seen).not.toBeNull();
    // The light left it some ~10M ago by its clock: it's seen as it was, not as it is.
    expect(seen!.tau).toBeLessThan(beacon.tau);
    expect(beacon.tau - seen!.tau).toBeGreaterThan(5);
  });
});

describe('tidal stretching', () => {
  it('is 2GML/r³: matches the relative acceleration of two particles released at rest', () => {
    const st = new Schwarzschild(1);
    const r = 12;
    const dr = 1e-3;
    const w = new World(st);
    const a = w.addParticle([r, 0, 0], [0, 0, 0]);
    const b = w.addParticle([r + dr, 0, 0], [0, 0, 0]);
    w.config.maxStep = 0.01;
    const T = 0.2;
    w.advance(T);
    // Separation grows as ½ (Δa) T² for a short time. Measured in coordinate time and radius,
    // the relative acceleration is d/dr[−(M/r²)(1 − 2M/r)] = (2M/r³)(1 − 3M/r): the free-fall
    // tidal stretch 2M/r³ seen through the coordinates' clock and ruler factors.
    const growth = b.x[1] - a.x[1] - dr;
    const measured = (2 * growth) / (T * T) / dr;
    expect(measured / ((2 / r ** 3) * (1 - 3 / r))).toBeCloseTo(1, 2);
    // In real units: a 100 m ship at 10M (148 km) from a 10-solar-mass hole is stretched by
    // 2GML/r³ ≈ 8.4 million g; at 10M from Gargantua it barely notices.
    expect(tidalAcceleration(10, 100, gravitationalRadius(10)) / 8.4e6).toBeCloseTo(1, 1);
    expect(tidalAcceleration(10, 100, gravitationalRadius(1e8))).toBeLessThan(1e-4);
  });
});

describe('the signal from home', () => {
  const hole = new Kerr(1, 0);
  /** Ship-frame direction of "straight up" (away from the hole), aberration included. */
  const upDir = (ship: Ship) => worldToShip(navState(hole, ship, 'river'), [0, 0, 1]);

  it('arrives blueshifted by exactly 1/√(1 − 2M/r) at a ship hovering at r', () => {
    const r = 5;
    const ship = new Ship(hole, [r, 0, 0], [0, 0, 0], [0, 1, 0], [1, 0, 0]);
    const s = homeSignal(hole, ship, upDir(ship))!;
    expect(s.g).toBeCloseTo(1 / Math.sqrt(1 - 2 / r), 3);
    // A naive Doppler speedometer reads that as racing toward home, while standing still.
    expect(s.dopplerSpeed).toBeLessThan(-0.15);
  });

  it('arrives redshifted by 1/(1 + √(2M/r)) at a ship falling from rest at infinity, even inside', () => {
    // Including a hair either side of the horizon (r₊ = 2), where the screen once went black.
    for (const r of [6, 2.01, 1.995, 1.5]) {
      const ship = new Ship(hole, [10, 0, 0], [0, 0, 0], [0, 1, 0], [1, 0, 0]);
      ship.x = [0, r, 0, 0];
      ship.u = navFrame(hole, ship.x, 'river').u; // falling with the river
      ship.orient(hole, ship.attitude().forward, ship.attitude().up);
      const s = homeSignal(hole, ship, upDir(ship))!;
      expect(s.g).toBeCloseTo(1 / (1 + Math.sqrt(2 / r)), 3);
      expect(s.dopplerSpeed).toBeGreaterThan(0); // it thinks you're receding
    }
  });
});
