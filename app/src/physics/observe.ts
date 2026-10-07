/**
 * What the ship actually receives, computed on the CPU with the same ray tracer as the GPU:
 * the light at the centre of the view, and when (by its own clock) each beacon's light now
 * arriving was emitted. These drive the sonification: you hear what you see.
 */

import type { Body } from './body';
import { type RayBody, type V4, lower, traceRay } from './kerrRays';
import type { Kerr } from './metrics/kerr';
import type { Ship } from './ship';

export interface ViewSample {
  kind: 'disk' | 'sky' | 'hole' | 'lost' | 'body';
  /** Received / emitted frequency ratio (1 where nothing is seen). */
  g: number;
}

/** Past-directed covariant ray momentum for ship-frame direction (right, up, forward). */
export function shipRay(ship: Ship, a: number, d: [number, number, number]): { x: V4; p: V4 } {
  const n = Math.hypot(...d);
  const k = [0, 1, 2, 3].map(
    (m) => -ship.u[m] + (d[0] * ship.e[0][m] + d[1] * ship.e[1][m] + d[2] * ship.e[2][m]) / n,
  ) as V4;
  const x: V4 = [0, ship.x[1], ship.x[2], ship.x[3]];
  return { x, p: lower(x, k, a) };
}

const COARSE = { stepScale: 0.03, maxSteps: 3000, escapeRadius: 2000 };

/** The light arriving dead ahead (or straight behind, looking back). */
export function sampleView(hole: Kerr, ship: Ship, diskIn: number, diskOut: number, back = false): ViewSample {
  const { x, p } = shipRay(ship, hole.a, [0, 0, back ? -1 : 1]);
  const inside = hole.radius(ship.x) < hole.horizonRadius;
  const end = traceRay(x, p, { a: hole.a, rHorizon: hole.horizonRadius, diskIn, diskOut, cameraInside: inside, ...COARSE });
  return { kind: end.kind, g: 'g' in end ? end.g : 1 };
}

export interface BeaconSighting {
  /** The beacon's own clock when the light now reaching you left it. */
  tau: number;
  g: number;
  /** Ship-frame direction where it was found (reused as the next search's starting point). */
  dir: [number, number, number];
}

/**
 * Find the beacon in the view: start from the last place it was seen (or the straight-line
 * direction) and search a small pattern around it with real light rays. Returns null when
 * no ray in the search reaches it (hidden, behind the hole, or lensed out of reach).
 */
export function sightBeacon(
  hole: Kerr,
  ship: Ship,
  body: Body,
  at: RayBody['at'],
  radius: number,
  start: [number, number, number] | null,
): BeaconSighting | null {
  let centre = start;
  if (!centre) {
    // Straight-line direction, expressed in the ship frame.
    const g = hole.metric(ship.x);
    const d: V4 = [0, body.x[1] - ship.x[1], body.x[2] - ship.x[2], body.x[3] - ship.x[3]];
    centre = [0, 1, 2].map((i) => {
      let s = 0;
      for (let m = 0; m < 4; m++) for (let n = 0; n < 4; n++) s += g[m][n] * ship.e[i][m] * d[n];
      return s;
    }) as [number, number, number];
    const len = Math.hypot(...centre);
    centre = centre.map((c) => c / len) as [number, number, number];
  }
  const inside = hole.radius(ship.x) < hole.horizonRadius;
  const target: RayBody = { radius, at };
  const spread = Math.max(0.02, radius / Math.max(1e-3, Math.hypot(body.x[1] - ship.x[1], body.x[2] - ship.x[2], body.x[3] - ship.x[3])));
  for (const [du, dv] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const d: [number, number, number] = [centre[0] + du * spread * 0.7, centre[1] + dv * spread * 0.7, centre[2]];
    const { x, p } = shipRay(ship, hole.a, d);
    const end = traceRay(x, p, {
      a: hole.a,
      rHorizon: hole.horizonRadius,
      diskIn: 0,
      diskOut: 0,
      cameraInside: inside,
      bodies: [target],
      ...COARSE,
    });
    if (end.kind === 'body') return { tau: end.tau, g: end.g, dir: d };
  }
  return null;
}

export interface HomeSignal {
  /** Received / emitted frequency of a signal from far away, arriving from straight "up". */
  g: number;
  /**
   * The speed a naive radio Doppler speedometer would infer, assuming flat space:
   * v = (1 − g²)/(1 + g²), positive when it thinks you're receding from home. It can't tell
   * gravitational shifts from motion, so near a hole it is fooled.
   */
  dopplerSpeed: number;
}

/**
 * The signal from home: light from far away arriving from straight up (the direction away
 * from the hole), traced back with the real ray tracer. Its frequency ratio is also the rate
 * at which home's clock ticks reach you. Null if no ray from that direction comes from the
 * far sky (which doesn't happen outside the hole).
 */
export function homeSignal(hole: Kerr, ship: Ship, up: [number, number, number]): HomeSignal | null {
  const { x, p } = shipRay(ship, hole.a, up);
  const inside = hole.radius(ship.x) < hole.horizonRadius;
  const end = traceRay(x, p, { a: hole.a, rHorizon: hole.horizonRadius, diskIn: 0, diskOut: 0, cameraInside: inside, ...COARSE });
  if (end.kind !== 'sky') return null;
  const g2 = end.g * end.g;
  return { g: end.g, dopplerSpeed: (1 - g2) / (1 + g2) };
}

/**
 * Tidal stretching along the radial direction for a body of length L metres at radius r,
 * in units of standard gravity: Δa ≈ 2GML/r³. Exact for a non-spinning hole in a freely
 * falling frame; a good guide for a spinning one away from the poles.
 */
export function tidalAcceleration(r: number, lengthMetres: number, metresPerM: number) {
  const C2 = 299_792_458 ** 2;
  // Geometric: Δa = 2 L/r³ in units of 1/M (with L, r in M); × c²/r_g gives m/s².
  const L = lengthMetres / metresPerM;
  return ((2 * L) / r ** 3) * (C2 / metresPerM) / 9.80665;
}
