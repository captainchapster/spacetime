import { Body, EVENT_STRIDE } from '../physics/body';
import type { RayBody } from '../physics/kerrRays';
import { type Vec4, inner } from '../physics/linalg';
import type { Ship } from '../physics/ship';
import type { Spacetime } from '../physics/spacetime';
import { World } from '../physics/world';
import { BODY_N, type BodyFrame, MAX_BODIES } from './renderer';

export interface BeaconLook {
  radius: number;
  temperature: number;
  /** Proper time between flashes, M. */
  pulse: number;
}

/** How far back (coordinate time, M) a beacon's worldline is kept visible to the renderer. */
const HISTORY = 4000;

/**
 * Beacons dropped from the ship: free-falling glowing spheres. Their worldlines are integrated
 * exactly (the same geodesic code as everything else) and handed to the renderer, which finds
 * where each backward-traced light ray meets them, so what you see of a beacon is light that
 * left it at the right moment, shifted by the right amount.
 */
export class Beacons {
  readonly world: World;

  constructor(readonly spacetime: Spacetime) {
    this.world = new World(spacetime);
    this.world.retain = Infinity; // a frozen image at the horizon needs its old history
    this.world.config.recordInterval = 0.05;
    this.world.config.maxStepsPerCall = 50000;
  }

  get list() {
    return this.world.bodies;
  }

  /** Release a beacon `ahead` M in front of the ship, moving forward at `speed` (c) relative to it. */
  launch(ship: Ship, speed: number, ahead: number) {
    const e3 = ship.e[2];
    const gamma = 1 / Math.sqrt(1 - speed * speed);
    const u = ship.u.map((c, i) => gamma * (c + speed * e3[i])) as Vec4;
    const x = ship.x.map((c, i) => c + ahead * e3[i]) as Vec4;
    x[0] = ship.x[0]; // released "now" by the ship's coordinate clock
    const body = new Body('massive', x, u, 0xffffff);
    this.world.bodies.push(body);
    while (this.world.bodies.length > MAX_BODIES) this.world.bodies.shift();
    return body;
  }

  /** Bring every beacon up to coordinate time t. */
  advanceTo(t: number) {
    if (this.world.bodies.length === 0) {
      this.world.time = t;
      return;
    }
    if (t > this.world.time) this.world.advance(t - this.world.time);
  }

  /** Sampled worldlines for the renderer, with times relative to `now`. */
  frames(now: number, camera: [number, number, number], look: BeaconLook): BodyFrame[] {
    const out: BodyFrame[] = [];
    const s = [0, 0, 0, 0, 0];
    const a = [0, 0, 0, 0, 0];
    const b = [0, 0, 0, 0, 0];
    for (const body of this.world.bodies) {
      const h = body.history;
      const tEnd = body.alive ? body.x[0] : h[h.length - EVENT_STRIDE];
      const tStart = Math.max(h[0], tEnd - HISTORY);
      if (!(tEnd - tStart > 1e-6)) continue;
      // Don't draw a beacon the camera is still inside (it was just launched).
      if (body.alive && Math.hypot(body.x[1] - camera[0], body.x[2] - camera[1], body.x[3] - camera[2]) < 3 * look.radius) {
        continue;
      }
      const dt = (tEnd - tStart) / (BODY_N - 1);
      const pos = new Float32Array(BODY_N * 3);
      const u = new Float32Array(BODY_N * 4);
      const tau = new Float32Array(BODY_N);
      const centre = [0, 0, 0];
      for (let k = 0; k < BODY_N; k++) {
        const t = tStart + k * dt;
        stateAt(body, t, s);
        pos.set([s[1], s[2], s[3]], 3 * k);
        tau[k] = s[4];
        // 4-velocity = d(event)/dτ, by central differences along the recorded worldline.
        const e = Math.max(0.5 * dt, 1e-3);
        stateAt(body, Math.max(tStart, t - e), a);
        stateAt(body, Math.min(tEnd, t + e), b);
        // Then rescale so g(u, u) = −1 exactly (differences get coarse where it moves fast).
        const w: Vec4 = b[4] > a[4] ? [b[0] - a[0], b[1] - a[1], b[2] - a[2], b[3] - a[3]] : [...body.u];
        const norm = -inner(this.spacetime.metric([0, s[1], s[2], s[3]]), w, w);
        u.set(norm > 0 ? w.map((c) => c / Math.sqrt(norm)) : body.u, 4 * k);
        for (let c = 0; c < 3; c++) centre[c] += s[c + 1] / BODY_N;
      }
      let reach = 0;
      for (let k = 0; k < BODY_N; k++) {
        reach = Math.max(reach, Math.hypot(pos[3 * k] - centre[0], pos[3 * k + 1] - centre[1], pos[3 * k + 2] - centre[2]));
      }
      out.push({
        pos,
        u,
        tau,
        t0: tStart - now,
        dt,
        radius: look.radius,
        temperature: look.temperature,
        pulse: look.pulse,
        bound: [centre[0], centre[1], centre[2], reach + look.radius],
      });
    }
    return out;
  }

  /**
   * The beacon as a ray-traceable body for the CPU tracer: its state at a time relative to
   * `now` (the clock the tracer's rays start from), from its recorded worldline.
   */
  rayBody(body: Body, now: number, radius: number): RayBody {
    const s = [0, 0, 0, 0, 0];
    const a = [0, 0, 0, 0, 0];
    const b = [0, 0, 0, 0, 0];
    const h = body.history;
    const first = h[0];
    const last = body.alive ? body.x[0] : h[h.length - EVENT_STRIDE];
    return {
      radius,
      at: (tRel: number) => {
        const t = now + tRel;
        if (t < first || t > last) return null;
        stateAt(body, t, s);
        const e = 0.05;
        stateAt(body, Math.max(first, t - e), a);
        stateAt(body, Math.min(last, t + e), b);
        const w: Vec4 = b[4] > a[4] ? [b[0] - a[0], b[1] - a[1], b[2] - a[2], b[3] - a[3]] : [...body.u];
        const norm = -inner(this.spacetime.metric([0, s[1], s[2], s[3]]), w, w);
        const u = (norm > 0 ? w.map((c) => c / Math.sqrt(norm)) : body.u) as Vec4;
        return { pos: [s[1], s[2], s[3]], u, tau: s[4] };
      },
    };
  }

  /** Speed relative to an observer hovering where the beacon is (null where none can). */
  speedVsHover(body: Body) {
    const g = this.spacetime.metric(body.x);
    if (g[0][0] >= 0) return null;
    const stat: Vec4 = [1 / Math.sqrt(-g[0][0]), 0, 0, 0];
    const gamma = -inner(g, stat, body.u);
    return Math.sqrt(Math.max(0, 1 - 1 / (gamma * gamma)));
  }
}

/** Event (t, x, y, z, τ) on a body's worldline at coordinate time t, including its live state. */
function stateAt(body: Body, t: number, out: number[]) {
  const h = body.history;
  const last = h.length - EVENT_STRIDE;
  if (t <= h[last] || !body.alive) {
    if (!body.sampleAt(Math.min(t, h[last]), out)) for (let i = 0; i < EVENT_STRIDE; i++) out[i] = h[i];
    return;
  }
  const live = [...body.x, body.tau];
  const f = Math.min(1, (t - h[last]) / Math.max(live[0] - h[last], 1e-12));
  for (let i = 0; i < EVENT_STRIDE; i++) out[i] = h[last + i] + f * (live[i] - h[last + i]);
}
