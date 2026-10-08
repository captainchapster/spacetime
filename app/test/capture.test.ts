import { describe, expect, it } from 'vitest';
import { iscoRadius } from '../src/physics/disk';
import { traceRay } from '../src/physics/kerrRays';
import { Kerr } from '../src/physics/metrics/kerr';
import { shipRay } from '../src/physics/observe';
import { Ship } from '../src/physics/ship';

/** A ship falling from rest at r0 (θ from the spin axis), stopped at radius r. */
function fallenTo(hole: Kerr, r0: number, thetaDeg: number, r: number) {
  const th = (thetaDeg * Math.PI) / 180;
  const R = Math.sqrt(r0 * r0 + hole.a * hole.a);
  const pos: [number, number, number] = [0, -R * Math.sin(th), r0 * Math.cos(th)];
  const ship = new Ship(hole, pos, [0, 0, 0], pos.map((c) => -c) as [number, number, number], [1, 0, 0]);
  while (hole.radius(ship.x) > r) ship.step(hole, 0.002, [0, 0, 0]);
  return ship;
}

describe('exact capture (constants of motion)', () => {
  it('stops only rays that really fall in: same fates (hole, disk or sky) as a fine integration without it', () => {
    for (const spin of [0.95, 0.5]) {
      const hole = new Kerr(1, spin);
      // With the accretion disk in place: a ray falling in may cross it first.
      const disk = { diskIn: iscoRadius(spin), diskOut: 14 };
      for (const [r, theta] of [[12, 80], [4, 80], [3, 30], [2, 89], [1.0, 80]] as const) {
        const ship = fallenTo(hole, 14, theta, r);
        const inside = hole.radius(ship.x) < hole.horizonRadius;
        let fast = 0;
        let slow = 0;
        let mismatches = 0;
        let compared = 0;
        // A spread of directions over the whole sky.
        for (let i = 0; i < 14; i++) {
          for (let j = 0; j < 7; j++) {
            const phi = (2 * Math.PI * i) / 14;
            const ct = -1 + (2 * (j + 0.5)) / 7;
            const st = Math.sqrt(1 - ct * ct);
            const d: [number, number, number] = [st * Math.cos(phi), st * Math.sin(phi), ct];
            const { x, p } = shipRay(ship, hole.a, d);
            const opts = { a: hole.a, rHorizon: hole.horizonRadius, ...disk, cameraInside: inside, escapeRadius: 500 };
            const exact = traceRay(x, p, { ...opts, stepScale: 0.03, maxSteps: 4000 });
            const truth = traceRay(x, p, { ...opts, stepScale: 0.005, maxSteps: 40000, exactCapture: false });
            fast += exact.steps;
            slow += truth.steps;
            // Rays the fine integration couldn't settle (out of steps) prove nothing either way.
            if (truth.steps >= 40000 || truth.kind === 'lost') continue;
            compared++;
            if (exact.kind !== truth.kind) mismatches++;
          }
        }
        expect(mismatches, `spin ${spin}, r ${r}: ${mismatches} of ${compared} fates differ`).toBe(0);
        expect(compared).toBeGreaterThan(60);
        expect(fast).toBeLessThan(slow);
      }
    }
  }, 600000);
});
