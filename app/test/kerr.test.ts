import { describe, expect, it } from 'vitest';
import { type V4, hamiltonian, lower, rayDerivs, traceRay } from '../src/physics/kerrRays';
import { inverse4, solveQuadratic } from '../src/physics/linalg';
import { Kerr, kerrRadius } from '../src/physics/metrics/kerr';
import { World } from '../src/physics/world';

const chi = 0.9;
const st = new Kerr(1, chi);
const a = st.a;

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
}

/** Covariant momentum of a past-directed null ray at x heading in spatial direction d. */
function nullRay(x: V4, d: [number, number, number], spin: number): V4 {
  // Solve g(k, k) = 0 for k^t with k = (k^t, d), using H(p) = ½ g(k, k) for p = g k.
  const H = (kt: number) => 2 * hamiltonian(x, lower(x, [kt, ...d], spin), spin);
  // H(kt) is quadratic in kt: recover its coefficients from three samples.
  const c = H(0);
  const s1 = H(1);
  const s2 = H(-1);
  const A = (s1 + s2) / 2 - c;
  const B = (s1 - s2) / 2;
  const kt = Math.min(...solveQuadratic(A, B, c)); // past-directed root
  return lower(x, [kt, ...d], spin);
}

/** Prograde (−) / retrograde (+) equatorial photon-orbit radius, M = 1. */
const photonOrbit = (sign: number) => 2 * (1 + Math.cos((2 / 3) * Math.acos(sign * chi)));
/** Its impact parameter ξ = L/E (Chandrasekhar), M = 1. */
const xi = (r: number) => -(r ** 3 - 3 * r * r + a * a * r + a * a) / (a * (r - 1));

describe('Kerr metric', () => {
  it('reduces to the horizon r₊ = M + √(M² − a²) and the right spheroidal radius', () => {
    expect(st.horizonRadius).toBeCloseTo(1 + Math.sqrt(1 - chi * chi), 12);
    expect(kerrRadius(Math.sqrt(36 + a * a), 0, 0, a)).toBeCloseTo(6, 12); // equator: ρ² = r² + a²
    expect(kerrRadius(0, 0, 5, a)).toBeCloseTo(5, 12); // pole: ρ = r
  });

  it('keeps a prograde circular orbit with Ω = 1/(r^{3/2} + a) inside the Schwarzschild ISCO', () => {
    // r = 3 is unstable without spin but stable prograde at χ = 0.9 (ISCO ≈ 2.32M).
    const r = 3;
    const R = Math.sqrt(r * r + a * a);
    const omega = 1 / (r ** 1.5 + a);
    const w = new World(st);
    const b = w.addParticle([R, 0, 0], [0, omega * R, 0]);
    const period = (2 * Math.PI) / omega;
    let worst = 0;
    while (w.time < 2 * period) {
      w.advance(1);
      worst = Math.max(worst, Math.abs(st.radius(b.x) - r));
    }
    expect(worst).toBeLessThan(1e-4);
    // Spin points along +z: the clockwise (retrograde) orbit there would outrun light.
    expect(() => w.addParticle([R, 0, 0], [0, -omega * R, 0])).toThrow();
  });
});

describe('ray tracer (mirrored by the GPU shader)', () => {
  it('uses exactly the metric: H = ½ g^μν p p and lowering = g_μν', () => {
    const rand = rng(7);
    for (let n = 0; n < 20; n++) {
      const x: V4 = [0, 8 * rand(), 8 * rand(), 8 * rand()];
      const p: V4 = [rand(), rand(), rand(), rand()];
      const g = st.metric(x);
      const gi = inverse4(g);
      let h = 0;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) h += 0.5 * gi[i][j] * p[i] * p[j];
      expect(hamiltonian(x, p, a)).toBeCloseTo(h, 10);
      const low = lower(x, p, a);
      for (let i = 0; i < 4; i++) expect(low[i]).toBeCloseTo(g[i].reduce((s, v, j) => s + v * p[j], 0), 10);
    }
  });

  it('has analytic derivatives matching ∂H/∂x and ∂H/∂p', () => {
    const rand = rng(11);
    for (let n = 0; n < 20; n++) {
      const x: V4 = [0, 6 * rand(), 6 * rand(), 3 * rand()];
      const p: V4 = [rand(), rand(), rand(), rand()];
      const [dx, dp] = rayDerivs(x, p, a);
      const e = 1e-6;
      for (let i = 0; i < 4; i++) {
        const xp = [...x] as V4;
        const xm = [...x] as V4;
        xp[i] += e;
        xm[i] -= e;
        const pp = [...p] as V4;
        const pm = [...p] as V4;
        pp[i] += e;
        pm[i] -= e;
        expect(dp[i]).toBeCloseTo(-(hamiltonian(xp, p, a) - hamiltonian(xm, p, a)) / (2 * e), 6);
        expect(dx[i]).toBeCloseTo((hamiltonian(x, pp, a) - hamiltonian(x, pm, a)) / (2 * e), 6);
      }
    }
  });

  /**
   * An equatorial ray seen by a camera far out on +x looking back at the hole: the
   * past-directed ray heads −x, so the light it receives was travelling +x, passing at
   * y ≈ b. Returns how it ends and its exact ξ = L_z/E (at finite distance ξ ≠ b).
   */
  function equatorialRay(b: number, spin = a) {
    const x: V4 = [0, 1000, b, 0];
    const p = nullRay(x, [-1, 0, 0], spin);
    const end = traceRay(x, p, {
      a: spin,
      rHorizon: 1 + Math.sqrt(1 - spin * spin),
      diskIn: 0,
      diskOut: 0,
      stepScale: 0.01,
      maxSteps: 200000,
      escapeRadius: 1100,
      cameraInside: false,
    });
    // Covariant p for the future-directed light is −p: E = p_t, L_z = −(x p_y − y p_x).
    return { kind: end.kind, xi: -(x[1] * p[2] - x[2] * p[1]) / p[0] };
  }

  /** Bisect for the edge of the shadow between a captured b and an escaping b; returns its ξ. */
  function shadowEdge(lo: number, hi: number, spin = a) {
    for (let n = 0; n < 40; n++) {
      const mid = 0.5 * (lo + hi);
      if (equatorialRay(mid, spin).kind === 'hole') lo = mid;
      else hi = mid;
    }
    return equatorialRay(0.5 * (lo + hi), spin).xi;
  }

  it('puts the edges of the shadow at the critical impact parameters of the photon orbits', () => {
    // Light passing at y = +b while travelling +x circles clockwise (L_z < 0): retrograde.
    // At y = −b it circles counterclockwise: prograde.
    expect(shadowEdge(0, 12)).toBeCloseTo(xi(photonOrbit(+1)), 3); // ≈ −6.83M: retrograde light is caught from further out
    expect(shadowEdge(0, -12)).toBeCloseTo(xi(photonOrbit(-1)), 3); // ≈ +2.85M: prograde light gets closer
  });

  it('reduces to the Schwarzschild capture threshold |ξ| = 3√3 M without spin', () => {
    expect(Math.abs(shadowEdge(0, 12, 0))).toBeCloseTo(3 * Math.sqrt(3), 3);
  });

  it('conserves H = 0 and the energy p_t along a ray that grazes the hole', () => {
    const x: V4 = [0, 50, 8, 1]; // just outside the shadow: bends hard, then escapes
    let p = nullRay(x, [-1, 0.05, 0], a);
    let y = x;
    const p0 = p[0];
    const h = 0.02;
    const at = (v: V4, k: V4, s: number) => v.map((c, i) => c + s * k[i]) as V4;
    for (let n = 0; n < 4000; n++) {
      const [k1x, k1p] = rayDerivs(y, p, a);
      const [k2x, k2p] = rayDerivs(at(y, k1x, h / 2), at(p, k1p, h / 2), a);
      const [k3x, k3p] = rayDerivs(at(y, k2x, h / 2), at(p, k2p, h / 2), a);
      const [k4x, k4p] = rayDerivs(at(y, k3x, h), at(p, k3p, h), a);
      y = y.map((v, i) => v + (h / 6) * (k1x[i] + 2 * k2x[i] + 2 * k3x[i] + k4x[i])) as V4;
      p = p.map((v, i) => v + (h / 6) * (k1p[i] + 2 * k2p[i] + 2 * k3p[i] + k4p[i])) as V4;
    }
    expect(kerrRadius(y[1], y[2], y[3], a)).toBeGreaterThan(20); // it came back out
    expect(p[0]).toBe(p0); // ∂H/∂t = 0 exactly
    expect(Math.abs(hamiltonian(y, p, a))).toBeLessThan(1e-8);
  });
});
