import { fourVelocity, renormalise } from './geodesic';
import { type Christoffel, type Vec4, inner } from './linalg';
import type { Spacetime } from './spacetime';

export type Vec3 = [number, number, number];

/** Thrust as a fixed vector, or a controller re-evaluated on every physics substep. */
export type Thrust = Vec3 | ((ship: Ship) => Vec3);

/**
 * A ship: a worldline plus an orthonormal frame (e1 right, e2 up, e3 forward), with
 * e0 = u its 4-velocity. With engines off it follows a geodesic. Thrust is a proper
 * acceleration A = aⁱ eᵢ given in the ship's own frame:
 *
 *   du/dτ  = −Γ(u, u) + A
 *   deᵢ/dτ = −Γ(u, eᵢ) + aᵢ u        (Fermi–Walker: the frame doesn't spin unless you turn it)
 *
 * Everything the player sees is rendered from this frame, so aberration, Doppler shift and
 * time dilation of the view come from the ship's real motion.
 */
export class Ship {
  x: Vec4;
  u: Vec4;
  e: [Vec4, Vec4, Vec4];
  /** Proper time elapsed on board. */
  tau = 0;
  /**
   * The inertial platform: three axes held steady by gyroscopes, as components along the
   * ship's axes (right, up, forward). Gyroscopes are Fermi–Walker transported, exactly like
   * the ship's own frame when it isn't turning, so these components change only when the ship
   * turns (they turn the opposite way). The navigation computer aligns the platform to the
   * local East–North–Up whenever it has a valid solution; without one it stays wherever the
   * gyroscopes hold it, as a real one would.
   */
  platform: number[][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  /** The journey is over (see `fate` for how). */
  crushed = false;
  /** How the journey ended: at the end of the trustworthy spacetime, or torn apart by tides. */
  fate: 'innerHorizon' | 'singularity' | 'tidal' | null = null;

  /** End the journey. */
  end(fate: NonNullable<Ship['fate']>) {
    this.crushed = true;
    this.fate = fate;
  }

  constructor(st: Spacetime, pos: Vec3, vel: Vec3, forward: Vec3, up: Vec3) {
    this.x = [0, ...pos];
    const u = fourVelocity(st, this.x, vel);
    if (!u) throw new Error('Ship velocity must be slower than light.');
    this.u = u;
    const right: Vec3 = [
      forward[1] * up[2] - forward[2] * up[1],
      forward[2] * up[0] - forward[0] * up[2],
      forward[0] * up[1] - forward[1] * up[0],
    ];
    this.e = [
      [0, ...right],
      [0, ...up],
      [0, ...forward],
    ];
    this.orthonormalise(st);
    this.handedness = this.frameOrientation();
  }

  /**
   * The frame's handedness: the sign of det[u; e1; e2; e3] in components. No real motion or
   * turn can change it (the frame never passes through a degenerate one), so it's fixed at
   * the start and restored if a rebuilt frame ever comes out mirrored.
   */
  private handedness = 1;

  private frameOrientation() {
    const m = [this.u, ...this.e].map((v) => [...v]);
    let det = 1;
    for (let c = 0; c < 4; c++) {
      let p = c;
      for (let r = c + 1; r < 4; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      if (p !== c) {
        [m[p], m[c]] = [m[c], m[p]];
        det = -det;
      }
      det *= m[c][c];
      for (let r = c + 1; r < 4; r++) {
        const k = m[r][c] / m[c][c];
        for (let j = c; j < 4; j++) m[r][j] -= k * m[c][j];
      }
    }
    return Math.sign(det);
  }

  /**
   * Point the ship's forward and up axes along the given 4-vectors (projected to be
   * orthogonal to its 4-velocity). Done by reaction wheels: it changes attitude, not motion.
   * Re-applying the ship's own `attitude()` leaves it exactly as it was.
   */
  orient(st: Spacetime, forward: Vec4, up: Vec4) {
    // Right ≈ forward × up (spatial parts) is only a hint: Gram–Schmidt turns it into one of the
    // two unit vectors orthogonal to u, up and forward. Moving fast in strongly curved
    // coordinates the hint can point nearer the wrong one, which would mirror the view, so
    // the frame's handedness is checked and restored.
    const held = this.platformAxes();
    const f = forward;
    const t = up;
    const right: Vec4 = [0, f[2] * t[3] - f[3] * t[2], f[3] * t[1] - f[1] * t[3], f[1] * t[2] - f[2] * t[1]];
    this.e = [right, [...up], [...forward]];
    this.orthonormalise(st);
    if (this.frameOrientation() !== this.handedness) this.e[0] = this.e[0].map((c) => -c) as Vec4;
    this.alignPlatform(st, held); // turning the ship doesn't turn the gyroscopes
  }

  /** The platform's three axes as 4-vectors. */
  platformAxes(): [Vec4, Vec4, Vec4] {
    return this.platform.map(
      (c) => [0, 1, 2, 3].map((m) => c[0] * this.e[0][m] + c[1] * this.e[1][m] + c[2] * this.e[2][m]) as Vec4,
    ) as [Vec4, Vec4, Vec4];
  }

  /** Set the platform's axes (4-vectors orthogonal to u; re-orthonormalised against drift). */
  alignPlatform(st: Spacetime, axes: Vec4[]) {
    const g = st.metric(this.x);
    const rows = axes.map((a) => this.e.map((e) => inner(g, a, e)));
    const done: number[][] = [];
    for (const k of [2, 1, 0]) {
      let w = rows[k];
      for (const d of done) {
        const p = w[0] * d[0] + w[1] * d[1] + w[2] * d[2];
        w = w.map((c, i) => c - p * d[i]);
      }
      const n = Math.hypot(...w);
      if (!(n > 1e-9)) return; // degenerate: keep the old alignment
      w = w.map((c) => c / n);
      done.push(w);
      rows[k] = w;
    }
    this.platform = rows;
  }

  /**
   * Turn the nose toward direction `dir` (any 4-vector; its part orthogonal to u is used),
   * by at most `maxAngle` radians, rolling as little as possible. Returns the angle still
   * left to turn (0 once on target).
   */
  turnToward(st: Spacetime, dir: Vec4, maxAngle: number): number {
    const g = st.metric(this.x);
    const unit = (v: Vec4) => {
      const n = Math.sqrt(Math.max(inner(g, v, v), 0));
      return n > 1e-12 ? (v.map((c) => c / n) as Vec4) : null;
    };
    const target = unit(dir.map((c, k) => c + inner(g, dir, this.u) * this.u[k]) as Vec4);
    if (!target) return 0;
    const f = this.e[2];
    const cos = Math.max(-1, Math.min(1, inner(g, f, target)));
    const angle = Math.acos(cos);
    let next = target;
    if (angle > maxAngle) {
      // Rotate within the plane of the current and target directions.
      const side = unit(target.map((c, k) => c - cos * f[k]) as Vec4) ?? this.e[1];
      next = f.map((c, k) => Math.cos(maxAngle) * c + Math.sin(maxAngle) * side[k]) as Vec4;
    }
    // Keep the current "up" unless the nose is swinging onto it; then use the old nose.
    const up = Math.abs(inner(g, next, this.e[1])) < 0.98 ? this.e[1] : f.map((c) => -c * Math.sign(inner(g, next, this.e[1]))) as Vec4;
    this.orient(st, next, up);
    return Math.max(0, angle - maxAngle);
  }

  /** The ship's current forward and up axes, for re-applying later with `orient`. */
  attitude(): { forward: Vec4; up: Vec4 } {
    return { forward: [...this.e[2]], up: [...this.e[1]] };
  }

  /**
   * Advance by proper time dTau under ship-frame proper acceleration (units 1/M). A thrust
   * function is re-evaluated every substep, so feedback (like the hover autopilot) stays
   * stable however much time each frame covers.
   */
  step(st: Spacetime, dTau: number, thrust: Thrust, maxSubsteps = 400) {
    if (this.crushed) return;
    // Substeps of a fixed fraction of the local timescale. If covering dTau would take more
    // than maxSubsteps, this call covers less: deep in the hole the game's time runs slower,
    // rather than the steps growing too big to be trusted.
    let remaining = dTau;
    for (let n = 0; n < maxSubsteps && remaining > 1e-15 * dTau; n++) {
      const acc = typeof thrust === 'function' ? thrust(this) : thrust;
      let h = Math.min(remaining, 0.004 * st.timescale(this.x));
      for (let tries = 0; ; tries++) {
        const before = { x: this.x, u: this.u, e: this.e };
        this.rk4(st, h, acc);
        // Accept only a sane step: finite, and not leaping across a sizeable part of the
        // scale on which the curvature changes (deep in a hole, the distance to the centre).
        const leap = Math.hypot(this.x[1] - before.x[1], this.x[2] - before.x[2], this.x[3] - before.x[3]);
        const scale = Math.max(Math.hypot(before.x[1], before.x[2], before.x[3]), st.timescale(before.x));
        if ([...this.x, ...this.u].every(Number.isFinite) && leap <= 0.25 * scale) break;
        Object.assign(this, before); // a bad step must never corrupt the ship: retry smaller
        if (tries === 30) return;
        h /= 2;
      }
      remaining -= h;
      this.orthonormalise(st);
      this.tau += h;
      if (st.isSingular(this.x)) {
        const ending = (st as { ending?: (x: Vec4) => Ship['fate'] }).ending?.(this.x);
        this.end(ending ?? 'singularity');
        return;
      }
    }
  }

  /** Turn the ship: rotate the frame by `angle` about e1 (pitch), e2 (yaw) or e3 (roll). */
  rotate(axis: 0 | 1 | 2, angle: number) {
    const [i, j] = axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [1, 0];
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const ei = this.e[i];
    const ej = this.e[j];
    this.e[i] = ei.map((v, k) => c * v + s * ej[k]) as Vec4;
    this.e[j] = ej.map((v, k) => -s * ei[k] + c * v) as Vec4;
    // The gyroscopes stay put, so their components along the turned axes change.
    for (const row of this.platform) {
      const pi = row[i];
      const pj = row[j];
      row[i] = c * pi + s * pj;
      row[j] = -s * pi + c * pj;
    }
  }

  /**
   * Thrust needed to hover: the 4-acceleration of an observer held at fixed coordinates,
   * Γ^μ_tt (u^t)², in the ship's frame, plus a critically damped correction that steers back
   * to `anchor` (if given) and bleeds off velocity relative to hovering observers, both on a
   * timescale `responseTime`. Null where hovering is impossible (inside the ergosphere).
   */
  hoverThrust(st: Spacetime, responseTime: number, anchor?: Vec3): Vec3 | null {
    const stat = this.staticObserver(st);
    if (!stat) return null;
    const G = st.christoffel(this.x);
    const ut = stat[0];
    const A: Vec4 = [0, 1, 2, 3].map((m) => G[m][0][0] * ut * ut) as Vec4;
    const g = st.metric(this.x);
    const off: Vec4 = anchor ? [0, anchor[0] - this.x[1], anchor[1] - this.x[2], anchor[2] - this.x[3]] : [0, 0, 0, 0];
    return [0, 1, 2].map((i) => {
      const v = inner(g, stat, this.e[i]); // = γ × velocity of the hover frame, seen from the ship
      return inner(g, A, this.e[i]) + (2 * v) / responseTime + inner(g, off, this.e[i]) / (responseTime * responseTime);
    }) as Vec3;
  }

  /** Velocity relative to an observer hovering at this spot, if one can exist here. */
  relativeToStatic(st: Spacetime) {
    const stat = this.staticObserver(st);
    if (!stat) return null;
    const g = st.metric(this.x);
    const gamma = -inner(g, stat, this.u);
    return { gamma, speed: Math.sqrt(Math.max(0, 1 - 1 / (gamma * gamma))) };
  }

  /** Proper acceleration felt by a hovering observer here (units 1/M), or null. */
  localGravity(st: Spacetime) {
    const stat = this.staticObserver(st);
    if (!stat) return null;
    const G = st.christoffel(this.x);
    const A: Vec4 = [0, 1, 2, 3].map((m) => G[m][0][0] * stat[0] * stat[0]) as Vec4;
    return Math.sqrt(Math.max(0, inner(st.metric(this.x), A, A)));
  }

  private staticObserver(st: Spacetime): Vec4 | null {
    const gtt = st.metric(this.x)[0][0];
    return gtt < 0 ? [1 / Math.sqrt(-gtt), 0, 0, 0] : null;
  }

  private rk4(st: Spacetime, h: number, acc: Vec3) {
    const deriv = (x: Vec4, u: Vec4, e: Vec4[]) => {
      const G = st.christoffel(x);
      const A: Vec4 = [0, 1, 2, 3].map((m) => acc[0] * e[0][m] + acc[1] * e[1][m] + acc[2] * e[2][m]) as Vec4;
      const du = [0, 1, 2, 3].map((m) => -contract(G, m, u, u) + A[m]) as Vec4;
      const de = e.map((ei, i) => [0, 1, 2, 3].map((m) => -contract(G, m, u, ei) + acc[i] * u[m]) as Vec4);
      return { dx: u, du, de };
    };
    const add = (v: Vec4, d: Vec4, s: number) => v.map((c, i) => c + s * d[i]) as Vec4;
    const x0 = this.x;
    const u0 = this.u;
    const e0 = this.e;
    const k1 = deriv(x0, u0, e0);
    const k2 = deriv(add(x0, k1.dx, h / 2), add(u0, k1.du, h / 2), e0.map((e, i) => add(e, k1.de[i], h / 2)));
    const k3 = deriv(add(x0, k2.dx, h / 2), add(u0, k2.du, h / 2), e0.map((e, i) => add(e, k2.de[i], h / 2)));
    const k4 = deriv(add(x0, k3.dx, h), add(u0, k3.du, h), e0.map((e, i) => add(e, k3.de[i], h)));
    const comb = (v: Vec4, a: Vec4, b: Vec4, c: Vec4, d: Vec4) =>
      v.map((q, i) => q + (h / 6) * (a[i] + 2 * b[i] + 2 * c[i] + d[i])) as Vec4;
    this.x = comb(x0, k1.dx, k2.dx, k3.dx, k4.dx);
    this.u = comb(u0, k1.du, k2.du, k3.du, k4.du);
    this.e = e0.map((e, i) => comb(e, k1.de[i], k2.de[i], k3.de[i], k4.de[i])) as [Vec4, Vec4, Vec4];
  }

  /**
   * Remove numerical drift: g(u, u) = −1, then Gram–Schmidt the frame against u in the order
   * forward → up → right, so where the ship points is disturbed least.
   */
  private orthonormalise(st: Spacetime) {
    this.u = renormalise(st, this.x, this.u, 'massive');
    const g = st.metric(this.x);
    const done: Vec4[] = [];
    const out = [...this.e] as [Vec4, Vec4, Vec4];
    for (const i of [2, 1, 0]) {
      const v = this.e[i];
      let w = v.map((c, k) => c + inner(g, v, this.u) * this.u[k]) as Vec4; // remove the u part
      for (const d of done) {
        const proj = inner(g, w, d);
        w = w.map((c, k) => c - proj * d[k]) as Vec4;
      }
      const n = Math.sqrt(inner(g, w, w));
      w = w.map((c) => c / n) as Vec4;
      done.push(w);
      out[i] = w;
    }
    this.e = out;
  }
}

function contract(G: Christoffel, m: number, a: Vec4, b: Vec4) {
  let s = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) s += G[m][i][j] * a[i] * b[j];
  return s;
}
