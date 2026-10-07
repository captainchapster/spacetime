import { describe, expect, it } from 'vitest';
import { TimeEmbedding } from '../src/physics/embedding';
import { Minkowski } from '../src/physics/metrics/minkowski';
import { Schwarzschild } from '../src/physics/metrics/schwarzschild';
import { spatialRadius } from '../src/physics/spacetime';
import { World } from '../src/physics/world';

const st = new Schwarzschild(1);
const emb = new TimeEmbedding(st.chart, 3, 30, 0.5);

/**
 * Integrate a geodesic of the surface metric h dt² + k dr² directly (RK4 in arc length),
 * from (t0, r0) with slope dr/dt = s0. Returns samples of (t, r).
 */
function surfaceGeodesic(e: TimeEmbedding, t0: number, r0: number, s0: number, tEnd: number) {
  const d = (f: (r: number) => number, r: number) => (f(r * (1 + 1e-6)) - f(r * (1 - 1e-6))) / (2e-6 * r);
  const h = (r: number) => e.h(r);
  const k = (r: number) => e.k(r);
  // Christoffels of a diagonal 2D metric depending only on r.
  const rhs = ([, r, vt, vr]: number[]) => [
    vt,
    vr,
    (-d(h, r) / h(r)) * vt * vr,
    (d(h, r) / (2 * k(r))) * vt * vt - (d(k, r) / (2 * k(r))) * vr * vr,
  ];
  const norm = Math.sqrt(h(r0) + k(r0) * s0 * s0);
  let y = [t0, r0, 1 / norm, s0 / norm];
  const out: [number, number][] = [[t0, r0]];
  const step = 0.002;
  while (y[0] < tEnd && y[1] > e.rInner && y[1] < e.rOuter) {
    const k1 = rhs(y);
    const k2 = rhs(y.map((v, i) => v + (step / 2) * k1[i]));
    const k3 = rhs(y.map((v, i) => v + (step / 2) * k2[i]));
    const k4 = rhs(y.map((v, i) => v + step * k3[i]));
    y = y.map((v, i) => v + (step / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
    out.push([y[0], y[1]]);
  }
  return out;
}

function interpolate(samples: [number, number][], t: number) {
  let i = samples.findIndex(([ts]) => ts >= t);
  if (i <= 0) return NaN;
  const [ta, ra] = samples[i - 1];
  const [tb, rb] = samples[i];
  return ra + ((t - ta) / (tb - ta)) * (rb - ra);
}

describe('time-warp embedding', () => {
  it('is an isometric drawing of h dt² + k dr²', () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    for (const r of [4, 8, 15, 25]) {
      const dt = 1e-3;
      emb.place(0, r, a);
      emb.place(dt, r, b);
      expect(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / dt).toBeCloseTo(Math.sqrt(emb.h(r)), 3);
      const dr = 0.05;
      emb.place(0, r + dr, b);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / dr;
      expect(Math.abs(len / Math.sqrt(emb.k(r + dr / 2)) - 1)).toBeLessThan(5e-3);
    }
  });

  it('flares toward the mass, and is a cylinder in flat spacetime', () => {
    expect(emb.radiusAt(4)).toBeGreaterThan(emb.radiusAt(25));
    const flat = new TimeEmbedding(new Minkowski().chart, 1, 20);
    expect(flat.radiusAt(2)).toBeCloseTo(flat.radiusAt(19), 10);
  });

  it('turns a thrown-up-and-falling body into a straight line on the surface', () => {
    // An "apple" thrown outward at r = 10M in the real simulation (Kerr–Schild time).
    const w = new World(st);
    const r0 = 10;
    const v = 0.25;
    const body = w.addParticle([r0, 0, 0], [v, 0, 0]);
    w.config.recordInterval = 0.05;
    while (body.alive && w.time < 120) w.advance(0.5);

    // Same initial point and direction on the surface, in static-chart time.
    const dtS = 1 - v * (2 / (r0 - 2)); // dt_S/dt_KS = 1 − (2M/(r − 2M))·dr/dt_KS
    const t0 = st.chart.staticTime(0, r0);
    const geo = surfaceGeodesic(emb, t0, r0, v / dtS, t0 + 200);

    const deviation = (g: [number, number][]) => {
      let worst = 0;
      let compared = 0;
      for (let i = 0; i < body.history.length; i += 5) {
        const r = spatialRadius([0, body.history[i + 1], body.history[i + 2], body.history[i + 3]]);
        if (r < emb.rInner + 0.5) break;
        const rGeo = interpolate(g, st.chart.staticTime(body.history[i], r));
        if (Number.isNaN(rGeo)) continue;
        worst = Math.max(worst, Math.abs(rGeo - r));
        compared++;
      }
      return { worst, compared };
    };

    let rMax = 0;
    for (let i = 1; i < body.history.length; i += 5) rMax = Math.max(rMax, body.history[i]);
    expect(rMax).toBeGreaterThan(r0 + 3); // it really went up before coming down

    const onSurface = deviation(geo);
    expect(onSurface.compared).toBeGreaterThan(200);
    expect(onSurface.worst).toBeLessThan(2e-3);

    // Control: on the flat-time cylinder the same start gives a helix that never comes back.
    const flat = new TimeEmbedding(new Minkowski().chart, 3, 30, 0.5);
    expect(deviation(surfaceGeodesic(flat, t0, r0, v / dtS, t0 + 200)).worst).toBeGreaterThan(1);
  });
});
