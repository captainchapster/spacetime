import { expect, it } from 'vitest';
import { type V4, lower, traceRay } from '../src/physics/kerrRays';
import { Kerr } from '../src/physics/metrics/kerr';
import { Ship } from '../src/physics/ship';

/**
 * Regression: falling into the ergosphere, a few pixels inside the shadow lit up with blue
 * specks. Those rays should have been captured, but coarse steps near the horizon let them
 * leak out with absurd blueshifts (g ≈ 170). Every pixel's fate must now be the same at the
 * game's step size and a much finer one.
 */
it('shows no spurious light inside the shadow from inside the ergosphere', { timeout: 600000 }, () => {
  const hole = new Kerr(1, 0.95);
  const a = hole.a;
  // The "Hovering beside the disk" start, then free fall with attitude hold.
  const th = (84 * Math.PI) / 180;
  const R = Math.sqrt(28 * 28 + a * a);
  const pos: [number, number, number] = [0, -R * Math.sin(th), 28 * Math.cos(th)];
  const n = Math.hypot(...pos);
  const ship = new Ship(hole, pos, [0, 0, 0], [0, R * Math.sin(th) / n, -28 * Math.cos(th) / n], [0, 0, 1]);
  const held = ship.attitude();
  while (hole.radius(ship.x) > 1.89) {
    ship.step(hole, 0.02, [0, 0, 0]);
    ship.orient(hole, held.forward, held.up);
  }
  expect(hole.metric(ship.x)[0][0]).toBeGreaterThan(0); // we're inside the ergosphere

  const N = 31;
  const span = Math.tan(Math.PI / 6);
  let mismatched = 0;
  let checked = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const d = [span * (2 * i / (N - 1) - 1) * (5 / 3), span * (2 * j / (N - 1) - 1), 1];
      const len = Math.hypot(...d);
      const k = [0, 1, 2, 3].map((m) => -ship.u[m] + (d[0] * ship.e[0][m] + d[1] * ship.e[1][m] + d[2] * ship.e[2][m]) / len) as V4;
      const x: V4 = [0, ship.x[1], ship.x[2], ship.x[3]];
      const fate = (stepScale: number) =>
        traceRay(x, lower(x, k, a), {
          a,
          rHorizon: hole.horizonRadius,
          diskIn: 0,
          diskOut: 0,
          stepScale,
          maxSteps: 100000,
          escapeRadius: 2000,
          cameraInside: false,
        }).kind;
      const coarse = fate(0.03);
      const fine = fate(0.006);
      checked++;
      if ((coarse === 'sky') !== (fine === 'sky')) mismatched++;
    }
  }
  expect(checked).toBe(N * N);
  expect(mismatched).toBe(0);

  // The exact ray behind one of the reported specks: pixel (674, 268) of a 1000×600 view.
  const t = Math.tan(Math.PI / 6);
  const d = [((674.5 - 500) / 300) * t, ((600 - 268.5 - 300) / 300) * t, 1];
  const len = Math.hypot(...d);
  const k = [0, 1, 2, 3].map((m) => -ship.u[m] + (d[0] * ship.e[0][m] + d[1] * ship.e[1][m] + d[2] * ship.e[2][m]) / len) as V4;
  const x: V4 = [0, ship.x[1], ship.x[2], ship.x[3]];
  const speck = traceRay(x, lower(x, k, a), {
    a,
    rHorizon: hole.horizonRadius,
    diskIn: 0,
    diskOut: 0,
    stepScale: 0.03,
    maxSteps: 100000,
    escapeRadius: 2000,
    cameraInside: false,
  });
  expect(speck.kind).toBe('hole');
});
