import { type Vec4, inner, inverse4 } from './linalg';
import type { Ship } from './ship';
import { type Spacetime, spatialRadius } from './spacetime';

export type V3 = [number, number, number];

/**
 * The local "ground" frame for flight instruments: an observer at the ship's position and
 * their orthonormal East, North, Up axes.
 *  - Up points to increasing r (away from the hole), normal to surfaces of constant r.
 *  - North points toward the +z pole (the hole's spin axis); East completes a right-handed
 *    set, so it is the direction the hole spins.
 * The observer is a ZAMO (zero-angular-momentum observer): held at fixed r and latitude while
 * co-rotating with the frame dragging, at Ω = −g_tφ/g_φφ. Unlike an observer hovering at
 * fixed coordinates, ZAMOs exist all the way down to the horizon, so the instruments stay
 * smooth through the ergosphere. (Without spin a ZAMO simply hovers.) Their 4-velocity is
 * normal to slices of constant Boyer–Lindquist time t_BL = t − ∫ 2Mr/Δ dr. Inside the horizon
 * there are none.
 *
 * Or the observer is static: at rest relative to the far-away universe (fixed coordinates,
 * ticking with the far-away clock's time direction). That is "stationary" in the everyday
 * sense, but it exists only outside the ergosphere, where g_tt < 0; approaching it, anything
 * moves past such an observer at nearly c.
 *
 * Or the observer is the "river": space falling inward from rest at infinity (Hamilton &
 * Lisle's river model; for spin, Doran's observers: E = 1, zero angular momentum). They exist
 * everywhere, through both horizons, so speeds measured against them never jump. Someone
 * falling in from far away reads zero; someone hovering reads the escape speed √(2M/r),
 * swimming upstream. In Kerr–Schild form u_μ = (−1, c ∂_i r) with
 *   c = −2Mr / (2Mr + √(2Mr(r² + a²))),
 * which has no singularity at the horizon. (Derived from Doran's u_r = −√(2Mr(r²+a²))/Δ in
 * Boyer–Lindquist coordinates and dt_BL = dt − (2Mr/Δ) dr; the 1/Δ terms cancel.)
 */
export type Reference = 'static' | 'zamo' | 'river';

export interface NavFrame {
  kind: Reference;
  /**
   * False where the requested observer can't exist (stationary inside the ergosphere,
   * hold-still inside the horizon). The frame is then the river's, so the maths still runs,
   * but a real navigation computer would have no valid solution.
   */
  valid: boolean;
  u: Vec4;
  east: Vec4;
  north: Vec4;
  up: Vec4;
}

type WithRadius = Spacetime & { radius?: (x: ArrayLike<number>) => number; mass?: number; a?: number };

export function navFrame(st: WithRadius, x: Vec4, reference: Reference = 'zamo'): NavFrame {
  const g = st.metric(x);
  const gi = inverse4(g);

  // ∂_i r, by central differences of the spheroidal radius.
  const R = (p: Vec4) => (st.radius ? st.radius(p) : spatialRadius(p));
  const h = 1e-5 * Math.max(1, spatialRadius(x));
  const dr = [0, 1, 2, 3].map((i) => {
    if (i === 0) return 0;
    const a = [...x] as Vec4;
    const b = [...x] as Vec4;
    a[i] += h;
    b[i] -= h;
    return (R(a) - R(b)) / (2 * h);
  });

  // The observer, falling back where the requested one can't exist: static (outside the
  // ergosphere) → ZAMO (outside the horizon, Δ > 0) → river (everywhere).
  const M = st.mass ?? 0;
  const spin = st.a ?? 0;
  const r = R(x);
  const delta = r * r - 2 * M * r + spin * spin;
  // (Below the inner horizon Δ > 0 again, but inside the outer horizon we stay with the river.)
  const rPlus = M + Math.sqrt(Math.max(0, M * M - spin * spin));
  const zamoOk = delta > 1e-9 * r * r && r > rPlus;
  const staticOk = g[0][0] < -1e-9;
  const kind: Reference =
    reference === 'static' && staticOk ? 'static' : reference !== 'river' && zamoOk ? 'zamo' : 'river';
  // No quiet fallbacks: the requested observer either exists here or the solution is invalid.
  const valid = reference === 'river' || (reference === 'static' ? staticOk : zamoOk);
  let uCov: Vec4;
  if (kind === 'static') {
    uCov = [g[0][0], g[0][1], g[0][2], g[0][3]] as Vec4; // lowered ∂_t; normalised below
  } else if (kind === 'zamo') {
    uCov = dr.map((c, i) => -(i === 0 ? 1 : (-2 * M * r * c) / delta)) as Vec4;
  } else {
    const c = M > 0 ? (-2 * M * r) / (2 * M * r + Math.sqrt(2 * M * r * (r * r + spin * spin))) : 0;
    uCov = dr.map((d, i) => (i === 0 ? -1 : c * d)) as Vec4;
  }
  const raised = [0, 1, 2, 3].map((m) => gi[m].reduce((s, v, k) => s + v * uCov[k], 0));
  const norm = Math.sqrt(-raised.reduce((s, v, k) => s + v * uCov[k], 0));
  const u = raised.map((c) => c / norm) as Vec4;
  if (u[0] < 0) u.forEach((c, k) => (u[k] = -c)); // future-pointing

  const project = (v: Vec4, against: Vec4[]) => {
    let w = v.map((c, k) => c + inner(g, v, u) * u[k]) as Vec4;
    for (const d of against) {
      const p = inner(g, w, d);
      w = w.map((c, k) => c - p * d[k]) as Vec4;
    }
    const n = Math.sqrt(inner(g, w, w));
    return w.map((c) => c / n) as Vec4;
  };

  // Up: the gradient of r, raised with the inverse metric.
  const upHint = [0, 1, 2, 3].map((m) => gi[m].reduce((s, v, n) => s + v * dr[n], 0)) as Vec4;
  const up = project(upHint, []);

  // North: toward +z, unless we're right over a pole, where any horizontal direction will do.
  const rho = Math.hypot(x[1], x[2]);
  const northHint: Vec4 = rho > 1e-6 * Math.abs(x[3]) ? [0, 0, 0, 1] : [0, 0, 1, 0];
  const north = project(northHint, [up]);
  // East: the direction of the hole's spin; over a pole, whatever completes E × N = Up.
  const east = project(rho > 1e-6 * Math.abs(x[3]) ? [0, -x[2], x[1], 0] : [0, 1, 0, 0], [up, north]);
  return { kind, u, east, north, up, valid };
}

/** Attitude modes, like a spacecraft's SAS. */
export type LockMode =
  | 'free'
  | 'hold'
  | 'prograde'
  | 'retrograde'
  | 'radialIn'
  | 'radialOut'
  | 'normal'
  | 'antinormal'
  | 'target';

/**
 * The direction (a 4-vector) a lock mode wants the nose pointed, or null when it's undefined
 * (prograde while at rest, say). Each mode names a direction d in the local reference
 * observer's space:
 *  - prograde: your velocity relative to them; radial: along Up; normal: Up × velocity.
 * carried into the ship's own space by the boost between you (see boost()), which is how the
 * navball shows it, so a lock puts its marker dead centre on the ball.
 *  - target: the straight coordinate line to the target's current position (this ignores
 *    light delay and lensing, so it isn't quite where the target appears). It needs no
 *    reference observer, so it works even when the navigation solution doesn't.
 */
export function lockDirection(
  st: WithRadius,
  ship: Ship,
  mode: LockMode,
  target?: V3,
  reference: Reference = 'zamo',
): Vec4 | null {
  if (mode === 'target') return target ? [0, target[0] - ship.x[1], target[1] - ship.x[2], target[2] - ship.x[3]] : null;
  const f = navFrame(st, ship.x, reference);
  const g = st.metric(ship.x);
  const combine = (c: V3) => [0, 1, 2, 3].map((m) => c[0] * f.east[m] + c[1] * f.north[m] + c[2] * f.up[m]) as Vec4;
  const gamma = -inner(g, ship.u, f.u);
  const v4 = ship.u.map((c, k) => c / gamma - f.u[k]) as Vec4;
  const v = [f.east, f.north, f.up].map((a) => inner(g, v4, a)) as V3;
  const speed = Math.hypot(...v);
  let d: V3 | null = null;
  switch (mode) {
    case 'prograde':
    case 'retrograde':
      if (speed > 1e-9) d = v.map((c) => ((mode === 'prograde' ? 1 : -1) * c) / speed) as V3;
      break;
    case 'radialOut':
      d = [0, 0, 1];
      break;
    case 'radialIn':
      d = [0, 0, -1];
      break;
    case 'normal':
    case 'antinormal': {
      const n: V3 = [-v[1], v[0], 0]; // Up × v
      const len = Math.hypot(...n);
      if (len > 1e-9) d = n.map((c) => ((mode === 'normal' ? 1 : -1) * c) / len) as V3;
      break;
    }
  }
  if (!d) return null;
  return boost(g, f.u, ship.u, combine(d));
}

/**
 * The pure Lorentz boost taking 4-velocity `from` to `to`, applied to w:
 *   Λw = w + [g(from + to, w) / (1 + γ)] (from + to) − 2 g(from, w) to,   γ = −g(from, to).
 * It carries the reference observer's directions rigidly into the ship's own space: the
 * rotation-free way to compare two observers' axes, and what a navigation computer that
 * knows your velocity relative to them would do. Unlike aberration (which is about where
 * light appears to come from), it keeps angles: a sphere stays a sphere.
 */
export function boost(g: number[][], from: Vec4, to: Vec4, w: Vec4): Vec4 {
  const gamma = -inner(g, from, to);
  const s = from.map((c, k) => c + to[k]) as Vec4;
  const c1 = inner(g, s, w) / (1 + gamma);
  const c2 = 2 * inner(g, from, w);
  return w.map((c, k) => c + c1 * s[k] - c2 * to[k]) as Vec4;
}

/** A direction 4-vector as a unit vector along the ship's axes (right, up, forward). */
export function bodyDirection(st: Spacetime, ship: Ship, dir: Vec4): V3 | null {
  const g = st.metric(ship.x);
  const c = ship.e.map((e) => inner(g, dir, e)) as V3;
  const n = Math.hypot(...c);
  return n > 1e-12 ? (c.map((q) => q / n) as V3) : null;
}

/**
 * The navigation computer's job each moment: if the reference observer exists here, align
 * the gyro platform to their East–North–Up (boosted into the ship's space). Returns whether
 * it could. When it can't, the platform is left to the gyroscopes.
 */
export function alignPlatform(st: WithRadius, ship: Ship, reference: Reference): boolean {
  const f = navFrame(st, ship.x, reference);
  if (!f.valid) return false;
  const g = st.metric(ship.x);
  ship.alignPlatform(st, [f.east, f.north, f.up].map((a) => boost(g, f.u, ship.u, a)));
  return true;
}

function toENUOf(f: NavFrame, g: number[][], dir: Vec4): V3 | null {
  const w = dir.map((c, k) => c + inner(g, dir, f.u) * f.u[k]) as Vec4;
  const c = [f.east, f.north, f.up].map((a) => inner(g, w, a)) as V3;
  const n = Math.hypot(...c);
  return n > 1e-12 ? (c.map((q) => q / n) as V3) : null;
}

/** A direction 4-vector as (east, north, up) components seen by the reference observer. */
export function toENU(st: WithRadius, ship: Ship, dir: Vec4, reference: Reference = 'zamo'): V3 | null {
  return toENUOf(navFrame(st, ship.x, reference), st.metric(ship.x), dir);
}

export interface NavState {
  /** The observer actually used, and the one asked for (they differ where it can't exist). */
  frame: NavFrame['kind'];
  requested: Reference;
  /** Whether the requested observer exists here (see NavFrame.valid). */
  valid: boolean;
  /**
   * The navball: the local East, North and Up axes (rows) as components along the ship's axes
   * (right, up, forward). A rotation matrix, so the ball is rigid. With a valid solution it
   * is the reference observer's axes boosted into the ship's space; without one, wherever
   * the gyro platform holds it.
   */
  ball: number[][];
  /** Where the ship's nose, roof and right side point in the ball's East–North–Up axes. */
  forward: V3;
  top: V3;
  right: V3;
  /** Velocity relative to the reference observer, in units of c. */
  velocity: V3;
  speed: number;
  gamma: number;
  /** Degrees: compass heading (0 = north, 90 = east), pitch above the horizon, roll. */
  heading: number;
  pitch: number;
  roll: number;
  /**
   * Exact aberration between the ship's view and the local frame. With A[i][k] = g(eᵢ, Eₖ),
   * W = g(u_ship, Eₖ) and B = g(u_ref, eᵢ):
   *   world direction seen at ship-frame direction s:  normalise(sᵢ A[i] − W)
   *   ship-frame direction where world direction d appears:  normalise(A[·]·d − B)
   */
  A: number[][];
  W: V3;
  B: V3;
}

/** Ship-frame direction (right, up, forward) of a navball direction d (east, north, up). */
export function toBody(n: NavState, d: V3): V3 {
  return [0, 1, 2].map((i) => d[0] * n.ball[0][i] + d[1] * n.ball[1][i] + d[2] * n.ball[2][i]) as V3;
}

/**
 * Ship-frame direction (right, up, forward) where light from world direction d (east, north,
 * up) appears: optics, with aberration. (The navball doesn't use this: see `ball`.)
 */
export function worldToShip(n: NavState, d: V3): V3 {
  const a = n.A.map((row, i) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2] - n.B[i]) as V3;
  const len = Math.hypot(...a);
  return a.map((c) => c / len) as V3;
}

/** World direction (east, north, up) seen at ship-frame direction s (right, up, forward). */
export function shipToWorld(n: NavState, s: V3): V3 {
  const d = [0, 1, 2].map((k) => s[0] * n.A[0][k] + s[1] * n.A[1][k] + s[2] * n.A[2][k] - n.W[k]) as V3;
  const len = Math.hypot(...d);
  return d.map((c) => c / len) as V3;
}

/** Where the ship points and how it moves, as its instruments would show. */
export function navState(st: WithRadius, ship: Ship, reference: Reference = 'zamo'): NavState {
  const f = navFrame(st, ship.x, reference);
  const g = st.metric(ship.x);
  const axes = [f.east, f.north, f.up];
  const gamma = -inner(g, ship.u, f.u);
  // u_ship = γ (u_ref + v):  v = u_ship/γ − u_ref, purely spatial for the reference observer.
  const v4 = ship.u.map((c, k) => c / gamma - f.u[k]) as Vec4;
  const velocity = axes.map((a) => inner(g, v4, a)) as V3;
  const A = ship.e.map((e) => axes.map((a) => inner(g, e, a)));
  const W = axes.map((a) => inner(g, ship.u, a)) as V3;
  const B = ship.e.map((e) => inner(g, f.u, e)) as V3;
  const ball = f.valid
    ? axes.map((a) => {
        const b = boost(g, f.u, ship.u, a);
        return ship.e.map((e) => inner(g, b, e));
      })
    : ship.platform.map((row) => [...row]);
  const column = (i: number) => [ball[0][i], ball[1][i], ball[2][i]] as V3;
  const forward = column(2);
  const top = column(1);
  const right = column(0);
  const deg = 180 / Math.PI;
  return {
    frame: f.kind,
    requested: reference,
    valid: f.valid,
    forward,
    top,
    right,
    velocity,
    speed: Math.hypot(...velocity),
    gamma,
    heading: ((Math.atan2(forward[0], forward[1]) * deg) % 360 + 360) % 360,
    pitch: Math.asin(Math.max(-1, Math.min(1, forward[2]))) * deg,
    roll: Math.atan2(-right[2], top[2]) * deg,
    ball,
    A,
    W,
    B,
  };
}
