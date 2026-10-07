/**
 * Light rays in Kerr, traced exactly as the GPU shader does (src/flight/shaders.ts mirrors
 * this file line for line, so the tests here vouch for the pixels).
 *
 * A ray is (x^μ, p_μ) evolving under H = ½ g^μν p_μ p_ν, which in Kerr–Schild form is
 *   g^μν = η^μν − f l^μ l^ν,   l^μ = (−1, l_x, l_y, l_z)
 *   H = ½ η^μν p_μ p_ν − ½ f L²,   L = l^μ p_μ
 * so  dx^μ/dλ = η^μν p_ν − f L l^μ   and   dp_i/dλ = ½ ∂_i f L² + f L ∂_i L.
 * All derivatives are analytic: no finite differences, which matter in 32-bit floats.
 * Units: M = 1.
 */

import { kerrRadius } from './metrics/kerr';

export type V4 = [number, number, number, number];

/** Kerr–Schild pieces at (x, y, z): f, l (covariant spatial part), and r. */
function ks(X: number, Y: number, Z: number, a: number) {
  const r = kerrRadius(X, Y, Z, a);
  const r2 = r * r;
  const ra = r2 + a * a;
  const S = r2 * r2 + a * a * Z * Z;
  const f = (2 * r2 * r) / S;
  return { r, r2, ra, S, f, lx: (r * X + a * Y) / ra, ly: (r * Y - a * X) / ra, lz: Z / r };
}

/** Lower a contravariant vector at x: g_μν k^ν = η k + f (l·k) l_μ, with l_μ = (1, lx, ly, lz). */
export function lower(x: V4, k: V4, a: number): V4 {
  const { f, lx, ly, lz } = ks(x[1], x[2], x[3], a);
  const lk = k[0] + lx * k[1] + ly * k[2] + lz * k[3];
  return [-k[0] + f * lk, k[1] + f * lk * lx, k[2] + f * lk * ly, k[3] + f * lk * lz];
}

/** H = ½ g^μν p_μ p_ν (zero for light). */
export function hamiltonian(x: V4, p: V4, a: number) {
  const { f, lx, ly, lz } = ks(x[1], x[2], x[3], a);
  const L = -p[0] + lx * p[1] + ly * p[2] + lz * p[3];
  return 0.5 * (-p[0] * p[0] + p[1] * p[1] + p[2] * p[2] + p[3] * p[3]) - 0.5 * f * L * L;
}

/** Hamilton's equations: returns [dx/dλ, dp/dλ]. */
export function rayDerivs(x: V4, p: V4, a: number): [V4, V4] {
  const X = x[1];
  const Y = x[2];
  const Z = x[3];
  const { r, r2, ra, S, f, lx, ly, lz } = ks(X, Y, Z, a);
  const L = -p[0] + lx * p[1] + ly * p[2] + lz * p[3];
  const dx: V4 = [-p[0] + f * L, p[1] - f * L * lx, p[2] - f * L * ly, p[3] - f * L * lz];

  // ∂r/∂x_i from differentiating the defining quartic.
  const dr = [(r2 * r * X) / S, (r2 * r * Y) / S, (r * Z * ra) / S];
  // f = 2r³/S:  ∂f = 2r²(3S − 4r⁴)/S² ∂r − 4 r³ a² z/S² ∂z
  const dfdr = (2 * r2 * (3 * S - 4 * r2 * r2)) / (S * S);
  const df = [dfdr * dr[0], dfdr * dr[1], dfdr * dr[2] - (4 * r2 * r * a * a * Z) / (S * S)];

  const dp: V4 = [0, 0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const di = dr[i];
    const ex = i === 0 ? 1 : 0;
    const ey = i === 1 ? 1 : 0;
    const ez = i === 2 ? 1 : 0;
    const dlx = ((di * X + r * ex + a * ey) * ra - (r * X + a * Y) * 2 * r * di) / (ra * ra);
    const dly = ((di * Y + r * ey - a * ex) * ra - (r * Y - a * X) * 2 * r * di) / (ra * ra);
    const dlz = (ez * r - Z * di) / r2;
    const dL = dlx * p[1] + dly * p[2] + dlz * p[3];
    dp[i + 1] = 0.5 * df[i] * L * L + f * L * dL;
  }
  return [dx, dp];
}

export type RayEnd =
  | { kind: 'hole'; steps: number }
  | { kind: 'sky'; dir: [number, number, number]; g: number; steps: number }
  | { kind: 'disk'; r: number; g: number; t: number; phi: number; steps: number }
  | { kind: 'body'; index: number; g: number; tau: number; steps: number }
  | { kind: 'lost'; steps: number; x: V4; p: V4 };

/** A small glowing sphere moving along a worldline (e.g. a dropped beacon). */
export interface RayBody {
  radius: number;
  /** Its state at coordinate time t (same clock as the ray's x⁰), or null outside its history. */
  at(t: number): { pos: [number, number, number]; u: V4; tau: number } | null;
}

/**
 * Radius of the prograde equatorial photon orbit, the innermost of all photon orbits (M = 1).
 * A light ray that is inside it and moving inward has no turning point left: it will cross
 * the horizon. Traced backward from outside, such a ray is "captured" (it came from the hole).
 */
export function innerPhotonOrbit(a: number) {
  return 2 * (1 + Math.cos((2 / 3) * Math.acos(-a)));
}

/** Whether (x, p) is still a light ray: |H| small compared with the size of p. */
export function rayIsNull(x: V4, p: V4, a: number) {
  const scale = p[0] * p[0] + p[1] * p[1] + p[2] * p[2] + p[3] * p[3];
  return Math.abs(hamiltonian(x, p, a)) < 1e-3 * scale;
}

/** Sign of dr/dλ along a ray moving with dx/dλ at x (r being the Kerr spheroidal radius). */
export function radialDirection(x: V4, dx: V4, a: number) {
  const r = kerrRadius(x[1], x[2], x[3], a);
  return r * r * (x[1] * dx[1] + x[2] * dx[2]) + (r * r + a * a) * x[3] * dx[3];
}

export interface TraceOptions {
  a: number;
  rHorizon: number;
  diskIn: number;
  diskOut: number;
  /** Fraction of r moved per step. */
  stepScale: number;
  maxSteps: number;
  escapeRadius: number;
  cameraInside: boolean;
  bodies?: RayBody[];
}

/**
 * Where (as a fraction of the step) the ray segment x → xn first enters body b, judged with
 * the body at its position at the segment's mid-time, i.e. when the light passed it.
 */
export function bodyHit(x: V4, xn: V4, b: RayBody) {
  const st = b.at(0.5 * (x[0] + xn[0]));
  if (!st) return null;
  const d = [xn[1] - x[1], xn[2] - x[2], xn[3] - x[3]];
  const w = [st.pos[0] - x[1], st.pos[1] - x[2], st.pos[2] - x[3]];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const s = Math.min(Math.max((w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / dd, 0), 1);
  const miss2 = (w[0] - s * d[0]) ** 2 + (w[1] - s * d[1]) ** 2 + (w[2] - s * d[2]) ** 2;
  if (miss2 > b.radius * b.radius) return null;
  const entry = Math.max(0, s - Math.sqrt((b.radius * b.radius - miss2) / dd));
  return { s: entry, u: st.u, tau: st.tau };
}

function axpy(x: V4, k: V4, h: number): V4 {
  return [x[0] + h * k[0], x[1] + h * k[1], x[2] + h * k[2], x[3] + h * k[3]];
}

/**
 * Trace a ray backward from the camera. `x0` is the camera event and `p0` the covariant
 * momentum of the past-directed ray, normalised so that p·u_camera = 1; then the
 * frequency ratio received/emitted for whatever the ray reaches is g = 1/(p·u_emitter).
 */
export function traceRay(x0: V4, p0: V4, o: TraceOptions): RayEnd {
  let x = [...x0] as V4;
  let p = [...p0] as V4;
  const rCapture = innerPhotonOrbit(Math.abs(o.a)) * 0.995;
  for (let n = 0; n < o.maxSteps; n++) {
    const r = kerrRadius(x[1], x[2], x[3], o.a);
    if (o.cameraInside && r < 0.05) return { kind: 'hole', steps: n };
    const [k1x, k1p] = rayDerivs(x, p, o.a);
    // Hugging the horizon from outside and still heading in: it never gets out. (Only heading
    // in: from a camera a hair above the horizon, the outward rays must still be traced.)
    if (!o.cameraInside && r < o.rHorizon * 1.01 && radialDirection(x, k1x, o.a) < 0) return { kind: 'hole', steps: n };
    // Inside every photon orbit and heading in: no way back out. Stopping here, rather than
    // integrating on toward the horizon, also avoids the stiff region where coarse steps
    // can let a captured ray leak out with a wildly wrong blueshift.
    if (!o.cameraInside && r < rCapture && radialDirection(x, k1x, o.a) < 0) return { kind: 'hole', steps: n };
    const spatial = Math.hypot(k1x[1], k1x[2], k1x[3]);
    if (r > o.escapeRadius && x[1] * k1x[1] + x[2] * k1x[2] + x[3] * k1x[3] > 0) {
      // A ray that has stopped being null was wrecked by integration error: don't trust it.
      if (!rayIsNull(x, p, o.a)) return { kind: 'lost', steps: n, x, p };
      return { kind: 'sky', dir: [k1x[1] / spatial, k1x[2] / spatial, k1x[3] / spatial], g: 1 / p[0], steps: n };
    }
    // Step length is set by how fast the ray moves through space, but light can momentarily
    // stand still in these coordinates (at the ergosphere's surface, where g_tt = 0), so its
    // motion through time bounds the step too.
    const speed = Math.max(spatial, 0.5 * Math.abs(k1x[0]));
    // Shorter steps close to the horizon, where the light paths bend hardest; longer ones
    // far out, where they barely bend at all.
    // (Measured from either side of either horizon: from inside, rays far from both still
    // get long steps.)
    const rInner = Math.abs(o.a) > 0 ? 2 - o.rHorizon : 0; // r₋ = M − √(M² − a²), M = 1
    const nearness = Math.min(Math.max(Math.min(Math.abs(r - o.rHorizon), Math.abs(r - rInner)) / o.rHorizon, 0.08), 1);
    const far = Math.min(Math.max(r / 30, 1), 8);
    const h = (o.stepScale * r * nearness * far) / speed;

    const [k2x, k2p] = rayDerivs(axpy(x, k1x, h / 2), axpy(p, k1p, h / 2), o.a);
    const [k3x, k3p] = rayDerivs(axpy(x, k2x, h / 2), axpy(p, k2p, h / 2), o.a);
    const [k4x, k4p] = rayDerivs(axpy(x, k3x, h), axpy(p, k3p, h), o.a);
    const xn = x.map((v, i) => v + (h / 6) * (k1x[i] + 2 * k2x[i] + 2 * k3x[i] + k4x[i])) as V4;
    const pn = p.map((v, i) => v + (h / 6) * (k1p[i] + 2 * k2p[i] + 2 * k3p[i] + k4p[i])) as V4;

    // A body in the way? (Checked before the disk; bodies are small, so overlap is rare.)
    if (o.bodies) {
      for (let i = 0; i < o.bodies.length; i++) {
        const hit = bodyHit(x, xn, o.bodies[i]);
        if (!hit) continue;
        const ph = p.map((v, k) => v + hit.s * (pn[k] - v)) as V4;
        const pu = ph[0] * hit.u[0] + ph[1] * hit.u[1] + ph[2] * hit.u[2] + ph[3] * hit.u[3];
        return { kind: 'body', index: i, g: 1 / pu, tau: hit.tau, steps: n };
      }
    }

    // Crossing the equatorial plane inside the disk's annulus?
    if (x[3] * xn[3] < 0) {
      const s = x[3] / (x[3] - xn[3]);
      const hit = x.map((v, i) => v + s * (xn[i] - v)) as V4;
      const ph = p.map((v, i) => v + s * (pn[i] - v)) as V4;
      const rh = kerrRadius(hit[1], hit[2], 0, o.a);
      if (rh >= o.diskIn && rh <= o.diskOut) {
        const g = 1 / diskDot(hit, ph, rh, o);
        return { kind: 'disk', r: rh, g, t: hit[0], phi: Math.atan2(hit[2], hit[1]), steps: n };
      }
    }
    x = xn;
    p = pn;
  }
  return { kind: 'lost', steps: o.maxSteps, x, p };
}

/** p·u for disk gas on a prograde circular equatorial geodesic at r. */
function diskDot(hit: V4, p: V4, r: number, o: TraceOptions) {
  const w = diskVelocity(hit, r, o.a);
  return w[0] * p[0] + w[1] * p[1] + w[2] * p[2];
}

/** 4-velocity (t, x, y components; z = 0) of disk gas at the equatorial point `hit`. */
export function diskVelocity(hit: V4, r: number, a: number): [number, number, number] {
  // Prograde: Ω = 1/(r^{3/2} + a), counterclockwise like the hole (for a ≥ 0).
  const omega = 1 / (r * Math.sqrt(r) + a);
  const vx = -omega * hit[2];
  const vy = omega * hit[1];
  // u^t from g(w, w) = −1 with w = (1, vx, vy, 0).
  const w: V4 = [1, vx, vy, 0];
  const wl = lower(hit, w, a);
  const n = wl[0] * w[0] + wl[1] * w[1] + wl[2] * w[2];
  const ut = 1 / Math.sqrt(-n);
  return [ut, ut * vx, ut * vy];
}
