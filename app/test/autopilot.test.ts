import { describe, expect, it } from 'vitest';
import { Kerr } from '../src/physics/metrics/kerr';
import { Schwarzschild } from '../src/physics/metrics/schwarzschild';
import { Ship, type Vec3 } from '../src/physics/ship';
import type { Spacetime } from '../src/physics/spacetime';

/** Hover with the autopilot evaluated every substep, as the game does, for `total` M of proper time. */
function hover(st: Spacetime & { radius?: (x: number[]) => number }, ship: Ship, total: number, perFrame: number) {
  const anchor: Vec3 = [ship.x[1], ship.x[2], ship.x[3]];
  const response = 40;
  let worst = 0;
  for (let t = 0; t < total; t += perFrame) {
    ship.step(st, perFrame, (s) => s.hoverThrust(st, response, anchor)!, 20000);
    worst = Math.max(worst, Math.hypot(ship.x[1] - anchor[0], ship.x[2] - anchor[1], ship.x[3] - anchor[2]));
  }
  return worst;
}

/** Angle the ship's forward axis has turned about +z, in the coordinate x–y plane. */
const heading = (ship: Ship) => Math.atan2(ship.e[2][2], ship.e[2][1]);

describe('hover autopilot', () => {
  it('holds position at any time warp (it used to blow up at ~300M per frame)', () => {
    const hole = new Kerr(1, 0.95);
    for (const perFrame of [0.03, 30, 300, 3000]) {
      const R = Math.sqrt(28 * 28 + 0.95 ** 2);
      const ship = new Ship(hole, [0, -R * Math.sin(1.466), 28 * Math.cos(1.466)], [0, 0, 0], [0, 1, 0], [0, 0, 1]);
      const worst = hover(hole, ship, Math.max(3 * perFrame, 600), perFrame);
      expect(worst).toBeLessThan(1e-3);
      expect(hole.radius(ship.x)).toBeCloseTo(28, 3);
    }
  });
});

describe('gyroscopes (the ship frame) held in place', () => {
  it('do not turn at all near a non-spinning hole', () => {
    const st = new Schwarzschild(1);
    const ship = new Ship(st, [0, -30, 0], [0, 0, 0], [1, 0, 0], [0, 0, 1]);
    hover(st, ship, 20000, 200);
    expect(Math.abs(heading(ship))).toBeLessThan(1e-4);
  });

  it('show Lense–Thirring precession near a spinning one: 2J/r³ prograde over the pole, J/r³ retrograde at the equator', () => {
    const J = 0.9; // a·M
    const r = 30;
    const T = 20000;
    const pole = new Kerr(1, 0.9);
    const above = new Ship(pole, [0, 0, r], [0, 0, 0], [1, 0, 0], [0, 1, 0]);
    hover(pole, above, T, 200);
    const tPole = above.x[0];
    expect(heading(above) / tPole).toBeGreaterThan(0); // prograde
    expect(heading(above) / tPole / ((2 * J) / r ** 3)).toBeCloseTo(1, 1); // weak-field value, O(M/r) corrections

    const side = new Ship(pole, [0, -Math.sqrt(r * r + J * J), 0], [0, 0, 0], [1, 0, 0], [0, 0, 1]);
    hover(pole, side, T, 200);
    const tSide = side.x[0];
    expect(heading(side) / tSide).toBeLessThan(0); // retrograde
    expect(-heading(side) / tSide / (J / r ** 3)).toBeCloseTo(1, 1);
  });

  it('stay pointed when attitude hold (reaction wheels) re-orients them', () => {
    const hole = new Kerr(1, 0.9);
    const ship = new Ship(hole, [0, 0, 30], [0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const held = ship.attitude();
    for (let i = 0; i < 100; i++) {
      hover(hole, ship, 200, 200);
      ship.orient(hole, held.forward, held.up);
    }
    expect(Math.abs(heading(ship))).toBeLessThan(1e-9);
  });
});

describe('attitude hold and mouse look', () => {
  const hole = new Kerr(1, 0.95);
  const frameOf = (s: Ship) => s.e.flat();

  it('re-applying the held attitude changes nothing, even for a fast-moving ship', () => {
    const ship = new Ship(hole, [9, -4, 2], [-0.2, 0.25, 0.05], [-1, 0.3, 0], [0, 0, 1]);
    ship.rotate(1, 0.4);
    ship.rotate(0, -0.3);
    const before = frameOf(ship);
    for (let i = 0; i < 1000; i++) ship.orient(hole, ship.attitude().forward, ship.attitude().up);
    frameOf(ship).forEach((v, k) => expect(v).toBeCloseTo(before[k], 12));
  });

  it('a mouse drag lands exactly where the same rotations would without attitude hold', () => {
    const a = new Ship(hole, [0, -20, 2], [0, 0, 0], [0, 1, 0], [0, 0, 1]);
    const b = new Ship(hole, [0, -20, 2], [0, 0, 0], [0, 1, 0], [0, 0, 1]);
    let held = a.attitude();
    for (let frame = 0; frame < 300; frame++) {
      // A few pointer events per frame, each turning a little and re-capturing the attitude…
      for (let ev = 0; ev < 3; ev++) {
        a.rotate(1, 0.002);
        a.rotate(0, -0.001);
        held = a.attitude();
        b.rotate(1, 0.002);
        b.rotate(0, -0.001);
      }
      // …then the frame's reaction-wheel pass.
      a.orient(hole, held.forward, held.up);
    }
    const fa = frameOf(a);
    frameOf(b).forEach((v, k) => expect(fa[k]).toBeCloseTo(v, 9));
  });
});
