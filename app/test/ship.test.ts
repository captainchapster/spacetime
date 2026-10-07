import { describe, expect, it } from 'vitest';
import { blackbodyRgb, blackbodyXYZ } from '../src/physics/blackbody';
import { circularOrbit, diskModel, iscoRadius, novikovThorneFlux } from '../src/physics/disk';
import { inner } from '../src/physics/linalg';
import { Kerr } from '../src/physics/metrics/kerr';
import { Minkowski } from '../src/physics/metrics/minkowski';
import { Schwarzschild } from '../src/physics/metrics/schwarzschild';
import { Ship } from '../src/physics/ship';
import { spatialRadius } from '../src/physics/spacetime';

describe('ship', () => {
  it('under constant thrust in flat space follows hyperbolic motion', () => {
    const st = new Minkowski();
    const ship = new Ship(st, [0, 0, 0], [0, 0, 0], [1, 0, 0], [0, 0, 1]);
    const g = 0.1;
    for (let n = 0; n < 100; n++) ship.step(st, 0.2, [0, 0, g]); // thrust along forward = +x
    const tau = 20;
    expect(ship.x[0]).toBeCloseTo(Math.sinh(g * tau) / g, 6);
    expect(ship.x[1]).toBeCloseTo((Math.cosh(g * tau) - 1) / g, 6);
    expect(ship.u[0]).toBeCloseTo(Math.cosh(g * tau), 6);
  });

  it('keeps its frame orthonormal and attached to its worldline', () => {
    const st = new Kerr(1, 0.9);
    const ship = new Ship(st, [8, 2, 1], [0, 0.3, 0.05], [-1, 0, 0], [0, 0, 1]);
    for (let n = 0; n < 50; n++) ship.step(st, 1, [0.01, -0.02, 0.005]);
    const g = st.metric(ship.x);
    const frame = [ship.u, ...ship.e];
    frame.forEach((a, i) =>
      frame.forEach((b, j) => expect(inner(g, a, b)).toBeCloseTo(i === j ? (i === 0 ? -1 : 1) : 0, 9)),
    );
  });

  it('needs exactly M/(r²√(1 − 2M/r)) of thrust to hover, and then stays put', () => {
    const st = new Schwarzschild(1);
    const r = 6;
    const ship = new Ship(st, [r, 0, 0], [0, 0, 0], [-1, 0, 0], [0, 0, 1]);
    const thrust = ship.hoverThrust(st, 5)!;
    expect(Math.hypot(...thrust)).toBeCloseTo(1 / (r * r * Math.sqrt(1 - 2 / r)), 6);
    for (let n = 0; n < 200; n++) ship.step(st, 0.5, ship.hoverThrust(st, 5)!);
    expect(spatialRadius(ship.x)).toBeCloseTo(r, 4);
    // Its clock runs slow by √(1 − 2M/r) against coordinate (far-away) time.
    expect(ship.tau / ship.x[0]).toBeCloseTo(Math.sqrt(1 - 2 / r), 4);
  });

  it('shows geodetic precession: a gyroscope orbiting at r turns by 2π(1 − √(1 − 3M/r)) per orbit', () => {
    const st = new Schwarzschild(1);
    const r = 10;
    const v = Math.sqrt(1 / r);
    const ship = new Ship(st, [r, 0, 0], [0, v, 0], [1, 0, 0], [0, 0, 1]); // "forward" points outward
    const start = [...ship.e[2]];
    const period = 2 * Math.PI * r ** 1.5; // coordinate time
    const tauPeriod = period * Math.sqrt(1 - 3 / r);
    const n = 400;
    for (let i = 0; i < n; i++) ship.step(st, tauPeriod / n, [0, 0, 0]);
    expect(spatialRadius(ship.x)).toBeCloseTo(r, 4);
    expect(ship.x[1]).toBeCloseTo(r, 3); // back where it started
    const turned = Math.acos(inner(st.metric(ship.x), start as never, ship.e[2]));
    expect(turned).toBeCloseTo(2 * Math.PI * (1 - Math.sqrt(1 - 3 / r)), 3);
  });
});

describe('accretion disk', () => {
  it('has the textbook ISCOs and orbit energies', () => {
    expect(iscoRadius(0)).toBeCloseTo(6, 10);
    expect(iscoRadius(0.998)).toBeCloseTo(1.237, 3);
    expect(1 - circularOrbit(6, 0).E).toBeCloseTo(1 - Math.sqrt(8 / 9), 10); // 5.7% efficiency
    expect(1 - circularOrbit(iscoRadius(0.998), 0.998).E).toBeCloseTo(0.321, 3); // Thorne's limit: 32%
  });

  it('matches the Page–Thorne closed-form flux, and vanishes at the ISCO', () => {
    // Reference values from the closed form, checked in validation/test_kerr_disk.py.
    const rIn = iscoRadius(0.5);
    const rs = [rIn, ...Array.from({ length: 2000 }, (_, i) => rIn + (i + 1) * 0.075)];
    const F = novikovThorneFlux(0.5, rs);
    expect(F[0]).toBe(0);
    const at = (r: number) => {
      const i = rs.findIndex((q) => q >= r);
      return F[i - 1] + ((r - rs[i - 1]) / (rs[i] - rs[i - 1])) * (F[i] - F[i - 1]);
    };
    expect(at(8) / 3.7860057e-5).toBeCloseTo(1, 4);
    expect(at(20) / 6.1211748e-6).toBeCloseTo(1, 4);
    expect(at(150) / 2.6400281e-8).toBeCloseTo(1, 3);
  });

  it('peaks near 10M for a non-spinning hole at about 10⁵ K for 10⁸ suns at the Eddington rate', () => {
    const d = diskModel(1e8, 0, 1, 400, 2048);
    expect(d.rPeak).toBeGreaterThan(9);
    expect(d.rPeak).toBeLessThan(11);
    expect(d.Tmax).toBeGreaterThan(5e4);
    expect(d.Tmax).toBeLessThan(2e5);
  });
});

describe('blackbody colour', () => {
  it('gives the Sun about the right luminance and a warm-white colour', () => {
    // The solar disc's luminance is about 1.6 × 10⁹ cd/m².
    expect(683 * blackbodyXYZ(5772)[1]).toBeGreaterThan(1.2e9);
    expect(683 * blackbodyXYZ(5772)[1]).toBeLessThan(2.4e9);
    const [r, g, b] = blackbodyRgb(3000);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    const [r2, , b2] = blackbodyRgb(20000);
    expect(b2).toBeGreaterThan(r2);
  });
});
