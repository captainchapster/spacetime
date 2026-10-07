import { type Christoffel, type Vec4, solveQuadratic } from './linalg';
import type { Spacetime } from './spacetime';

export type BodyKind = 'massive' | 'photon';

/** g(u, u) for each kind: −1 for proper-time-parametrised massive bodies, 0 for light. */
export function normFor(kind: BodyKind): number {
  return kind === 'massive' ? -1 : 0;
}

/** Geodesic equation: du^μ/dλ = −Γ^μ_αβ u^α u^β. */
function acceleration(G: Christoffel, u: Vec4): Vec4 {
  const out: Vec4 = [0, 0, 0, 0];
  for (let m = 0; m < 4; m++) {
    const Gm = G[m];
    let s = 0;
    for (let a = 0; a < 4; a++) {
      const row = Gm[a];
      for (let b = 0; b < 4; b++) s += row[b] * u[a] * u[b];
    }
    out[m] = -s;
  }
  return out;
}

function axpy(x: Vec4, k: Vec4, h: number): Vec4 {
  return [x[0] + h * k[0], x[1] + h * k[1], x[2] + h * k[2], x[3] + h * k[3]];
}

/** One classical Runge–Kutta step of size h in the affine parameter. */
export function rk4Step(st: Spacetime, x: Vec4, u: Vec4, h: number): { x: Vec4; u: Vec4 } {
  const k1u = acceleration(st.christoffel(x), u);
  const x2 = axpy(x, u, h / 2);
  const u2 = axpy(u, k1u, h / 2);
  const k2u = acceleration(st.christoffel(x2), u2);
  const x3 = axpy(x, u2, h / 2);
  const u3 = axpy(u, k2u, h / 2);
  const k3u = acceleration(st.christoffel(x3), u3);
  const x4 = axpy(x, u3, h);
  const u4 = axpy(u, k3u, h);
  const k4u = acceleration(st.christoffel(x4), u4);

  const xn: Vec4 = [0, 0, 0, 0];
  const un: Vec4 = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    xn[i] = x[i] + (h / 6) * (u[i] + 2 * u2[i] + 2 * u3[i] + u4[i]);
    un[i] = u[i] + (h / 6) * (k1u[i] + 2 * k2u[i] + 2 * k3u[i] + k4u[i]);
  }
  return { x: xn, u: un };
}

/**
 * Solve g(u, u) = norm for u^t, keeping the spatial components fixed.
 * Of the (up to two) positive roots, returns the one nearest `guess`.
 */
function solveForUt(st: Spacetime, x: Vec4, spatial: [number, number, number], norm: number, guess: number) {
  const g = st.metric(x);
  const A = g[0][0];
  let B = 0;
  let C = -norm;
  for (let i = 1; i <= 3; i++) {
    B += 2 * g[0][i] * spatial[i - 1];
    for (let j = 1; j <= 3; j++) C += g[i][j] * spatial[i - 1] * spatial[j - 1];
  }
  const roots = solveQuadratic(A, B, C).filter((r) => r > 0);
  if (roots.length === 0) return null;
  return roots.reduce((best, r) => (Math.abs(r - guess) < Math.abs(best - guess) ? r : best));
}

/**
 * Project numerical drift out of u by re-solving the normalisation g(u, u) = −1 (or 0)
 * for u^t. Without this, errors accumulate into bodies slowly turning superluminal.
 */
export function renormalise(st: Spacetime, x: Vec4, u: Vec4, kind: BodyKind): Vec4 {
  const ut = solveForUt(st, x, [u[1], u[2], u[3]], normFor(kind), u[0]);
  return ut === null ? u : [ut, u[1], u[2], u[3]];
}

/**
 * 4-velocity of a massive body at x moving with coordinate velocity v = dx/dt.
 * Null if v is not timelike there (faster than the local speed of light).
 */
export function fourVelocity(st: Spacetime, x: Vec4, v: [number, number, number]): Vec4 | null {
  const w: Vec4 = [1, v[0], v[1], v[2]];
  const g = st.metric(x);
  let n = 0;
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) n += g[a][b] * w[a] * w[b];
  if (n >= 0) return null;
  const ut = 1 / Math.sqrt(-n);
  return [ut, ut * v[0], ut * v[1], ut * v[2]];
}

/**
 * Future-directed null tangent at x heading in spatial direction `dir`, scaled so u^t = 1
 * (so the spatial part is the coordinate velocity of the light ray).
 */
export function nullTangent(st: Spacetime, x: Vec4, dir: [number, number, number]): Vec4 | null {
  const len = Math.hypot(...dir);
  if (len === 0) return null;
  const d = dir.map((c) => c / len) as [number, number, number];
  const g = st.metric(x);
  let A = 0;
  let B = 0;
  for (let i = 1; i <= 3; i++) {
    B += 2 * g[0][i] * d[i - 1];
    for (let j = 1; j <= 3; j++) A += g[i][j] * d[i - 1] * d[j - 1];
  }
  const speeds = solveQuadratic(A, B, g[0][0]).filter((s) => s > 0);
  if (speeds.length === 0) return null;
  const s = Math.max(...speeds);
  return [1, s * d[0], s * d[1], s * d[2]];
}
