import { describe, expect, it } from 'vitest';
import { inner } from '../src/physics/linalg';
import { coneSection } from '../src/physics/lightcone';
import { Minkowski } from '../src/physics/metrics/minkowski';
import { Schwarzschild } from '../src/physics/metrics/schwarzschild';
import { boundOrbit, circularOrbitSpeed, periapsisAdvance } from '../src/physics/orbits';
import { spatialRadius, staticClockRate } from '../src/physics/spacetime';
import { World } from '../src/physics/world';

const M = 1;

/** Step a world forward in small increments, calling `each` after every increment. */
function run(world: World, until: number, dt: number, each?: () => void) {
  while (world.time < until - 1e-12) {
    world.advance(Math.min(dt, until - world.time));
    each?.();
  }
}

describe('flat spacetime', () => {
  it('moves bodies in straight lines with time dilation τ = t/γ', () => {
    const w = new World(new Minkowski());
    const b = w.addParticle([0, 0, 0], [0.6, 0, 0]);
    run(w, 10, 1);
    expect(b.x[1]).toBeCloseTo(6, 10);
    expect(b.tau).toBeCloseTo(10 * Math.sqrt(1 - 0.36), 10);
  });

  it('rejects superluminal velocities and moves light at c', () => {
    const w = new World(new Minkowski());
    expect(() => w.addParticle([0, 0, 0], [0.8, 0.8, 0])).toThrow();
    const p = w.addPhoton([0, 0, 0], [1, 1, 0]);
    run(w, 10, 1);
    expect(spatialRadius(p.x)).toBeCloseTo(10, 10);
  });

  it('has unit light-cone sections', () => {
    const s = coneSection(new Minkowski().metric(), [1, 2])!;
    expect(s.centre).toEqual([0, 0]);
    expect(s.basis[0][0]).toBeCloseTo(1);
    expect(s.basis[1][1]).toBeCloseTo(1);
  });
});

describe('Schwarzschild (Kerr–Schild coordinates)', () => {
  const st = new Schwarzschild(M);

  it('keeps a circular orbit at r = 10M closed with period 2π√(r³/M)', () => {
    const w = new World(st);
    const r = 10;
    const b = w.addParticle([r, 0, 0], [0, circularOrbitSpeed(M, r), 0]);
    const period = 2 * Math.PI * Math.sqrt(r ** 3 / M);
    let rMin = Infinity;
    let rMax = 0;
    run(w, period, 1, () => {
      rMin = Math.min(rMin, spatialRadius(b.x));
      rMax = Math.max(rMax, spatialRadius(b.x));
    });
    expect(rMax - rMin).toBeLessThan(1e-4);
    expect(b.x[1]).toBeCloseTo(r, 3);
    expect(Math.abs(b.x[2])).toBeLessThan(1e-3);
    // Orbiting clock: dτ/dt = √(1 − 3M/r).
    expect(b.tau / period).toBeCloseTo(Math.sqrt(1 - (3 * M) / r), 6);
  });

  it('preserves the 4-velocity normalisation g(u, u) = −1', () => {
    const w = new World(st);
    const b = w.addParticle([8, 0, 0], [0, 0.4, 0.05]);
    run(w, 300, 2);
    expect(inner(st.metric(b.x), b.u, b.u)).toBeCloseTo(-1, 9);
  });

  it('advances the periapsis by the exact GR amount', () => {
    const r1 = 8;
    const r2 = 20;
    const w = new World(st);
    const b = w.addParticle([r1, 0, 0], [0, boundOrbit(M, r1, r2).speed, 0]);

    // Sample r and unwrapped φ finely, then locate the next periapsis by a parabola fit.
    const rs: number[] = [];
    const phis: number[] = [];
    let phi = 0;
    let prev = 0;
    run(w, 900, 0.05, () => {
      const a = Math.atan2(b.x[2], b.x[1]);
      let d = a - prev;
      if (d < -Math.PI) d += 2 * Math.PI;
      if (d > Math.PI) d -= 2 * Math.PI;
      phi += d;
      prev = a;
      rs.push(spatialRadius(b.x));
      phis.push(phi);
    });
    const i = rs.findIndex((r, k) => k > 10 && k < rs.length - 1 && r < rs[k - 1] && r <= rs[k + 1]);
    expect(i).toBeGreaterThan(0);
    const delta = (0.5 * (rs[i - 1] - rs[i + 1])) / (rs[i - 1] - 2 * rs[i] + rs[i + 1]);
    const phiPeri = phis[i] + (delta * (phis[i + 1] - phis[i - 1])) / 2;

    const expected = periapsisAdvance(M, r1, r2);
    expect(rs[i]).toBeCloseTo(r1, 3);
    expect(phiPeri - 2 * Math.PI).toBeCloseTo(expected, 3);
  });

  it('holds light on the photon sphere r = 3M for a while', () => {
    const w = new World(st);
    const p = w.addPhoton([3, 0, 0], [0, 1, 0]);
    run(w, 30, 1); // a bit under one orbit; the orbit is unstable, so errors grow exponentially
    expect(spatialRadius(p.x)).toBeCloseTo(3, 4);
  });

  it('lets a body fall through the horizon to the singularity in finite time', () => {
    const w = new World(st);
    const b = w.addParticle([10, 0, 0], [0, 0, 0]);
    run(w, 100, 1);
    expect(b.fate).toBe('absorbed');
    // Proper time to fall from rest at r0 to r = 0 is (π/2)·√(r0³/2M).
    expect(b.tau).toBeCloseTo((Math.PI / 2) * Math.sqrt(1000 / 2), 1);
  });

  it('slows static clocks by √(1 − 2M/r) and has no static observers inside the horizon', () => {
    expect(staticClockRate(st, [0, 4, 0, 0])).toBeCloseTo(Math.sqrt(0.5), 12);
    expect(staticClockRate(st, [0, 1.5, 0, 0])).toBeNull();
  });

  it('tilts light cones toward the hole, entirely inward inside the horizon', () => {
    const outside = coneSection(st.metric([0, 10, 0, 0]), [1, 2])!;
    expect(outside.centre[0]).toBeLessThan(0);
    expect(outside.centre[0] + outside.basis[0][0]).toBeGreaterThan(0); // can still escape

    const inside = coneSection(st.metric([0, 1.5, 0, 0]), [1, 2])!;
    const outermost = inside.centre[0] + Math.hypot(inside.basis[0][0], inside.basis[0][1]);
    expect(outermost).toBeLessThan(0); // every future light ray moves inward
  });
});
