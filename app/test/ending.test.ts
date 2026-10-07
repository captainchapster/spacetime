import { describe, expect, it } from 'vitest';
import { Kerr } from '../src/physics/metrics/kerr';
import { tidalAcceleration } from '../src/physics/observe';
import { Ship } from '../src/physics/ship';
import { gravitationalRadius } from '../src/physics/units';

/** Drop a ship from rest at r0 (angle θ from the spin axis) and let it fall until it ends. */
function fall(hole: Kerr, r0: number, thetaDeg: number) {
  const th = (thetaDeg * Math.PI) / 180;
  const R = Math.sqrt(r0 * r0 + hole.a * hole.a);
  const pos: [number, number, number] = [0, -R * Math.sin(th), r0 * Math.cos(th)];
  const n = Math.hypot(...pos);
  const ship = new Ship(hole, pos, [0, 0, 0], pos.map((c) => -c / n) as [number, number, number], [1, 0, 0]);
  let rMin = Infinity;
  for (let k = 0; k < 200000 && !ship.crushed; k++) {
    ship.step(hole, 0.01, [0, 0, 0], 100);
    rMin = Math.min(rMin, hole.radius(ship.x));
  }
  return { ship, rMin };
}

describe('where the journey ends', () => {
  it('ends a spinning hole at the inner horizon, not before (the realistic ending)', () => {
    for (const spin of [0.95, 0.6]) {
      const hole = new Kerr(1, spin);
      for (const theta of [80, 30]) {
        const { ship, rMin } = fall(hole, 12, theta);
        expect(ship.fate).toBe('innerHorizon');
        // Stopped within one step of r₋: the space between the horizons is all flown.
        expect(rMin).toBeLessThan(hole.innerHorizonRadius + 1e-6);
        expect(rMin).toBeGreaterThan(hole.innerHorizonRadius - 0.05);
      }
    }
  });

  it('ends a non-spinning hole at the central singularity, wherever you fall from', () => {
    const hole = new Kerr(1, 0);
    expect(hole.innerHorizonRadius).toBe(0);
    const { ship, rMin } = fall(hole, 12, 70);
    expect(ship.fate).toBe('singularity');
    expect(rMin).toBeLessThan(1e-3);
  });

  it('tides break the hull outside a small hole, but deep inside a giant one', () => {
    const at = (Msun: number, r: number) => tidalAcceleration(r, 100, gravitationalRadius(Msun));
    // 10 solar masses: past 1000 g well outside the horizon (r = 2M).
    expect(at(10, 6)).toBeGreaterThan(1000);
    // 10⁸ solar masses: barely felt at the horizon, still under 1000 g at r = 0.01 M.
    expect(at(1e8, 2)).toBeLessThan(1e-3);
    expect(at(1e8, 0.01)).toBeLessThan(1000);
  });
});
