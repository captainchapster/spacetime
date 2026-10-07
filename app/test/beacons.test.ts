import { describe, expect, it } from 'vitest';
import { renormalise } from '../src/physics/geodesic';
import { type RayBody, type V4, hamiltonian, lower, traceRay } from '../src/physics/kerrRays';
import { solveQuadratic } from '../src/physics/linalg';
import { Kerr } from '../src/physics/metrics/kerr';

const st = new Kerr(1, 0);

/**
 * Past-directed null ray from x heading in spatial direction d, scaled so p·u_cam = 1 for a
 * camera with 4-velocity uCam (so g = 1/(p·u_emitter) is directly the frequency ratio).
 */
function cameraRay(x: V4, d: [number, number, number], uCam: V4): V4 {
  const H = (kt: number) => 2 * hamiltonian(x, lower(x, [kt, ...d], 0), 0);
  const c = H(0);
  const s1 = H(1);
  const s2 = H(-1);
  const kt = Math.min(...solveQuadratic((s1 + s2) / 2 - c, (s1 - s2) / 2, c));
  const p = lower(x, [kt, ...d], 0);
  const pu = p.reduce((s, v, i) => s + v * uCam[i], 0);
  return p.map((v) => v / pu) as V4;
}

const staticU = (r: number): V4 => [1 / Math.sqrt(1 - 2 / r), 0, 0, 0];

function trace(x: V4, p: V4, bodies: RayBody[]) {
  return traceRay(x, p, {
    a: 0,
    rHorizon: 2,
    diskIn: 0,
    diskOut: 0,
    stepScale: 0.005,
    maxSteps: 100000,
    escapeRadius: 5000,
    cameraInside: false,
    bodies,
  });
}

describe('beacons seen through the ray tracer', () => {
  const cam: V4 = [0, 1000, 0, 0];
  const uCam = staticU(1000);

  it('redshifts a hovering beacon by exactly √(1 − 2M/r) (relative to the camera)', () => {
    const beacon: RayBody = { radius: 0.2, at: () => ({ pos: [4, 0, 0], u: staticU(4), tau: 0 }) };
    const end = trace(cam, cameraRay(cam, [-1, 0, 0], uCam), [beacon]);
    expect(end.kind).toBe('body');
    if (end.kind !== 'body') return;
    expect(end.g).toBeCloseTo(Math.sqrt(1 - 2 / 4) / Math.sqrt(1 - 2 / 1000), 4);
  });

  it('shifts light from a beacon falling in from rest at infinity by 1 − √(2M/r)', () => {
    const r = 6;
    // Radial infall with E = 1: dr/dτ = −√(2M/r); u^t follows from g(u, u) = −1.
    const u = renormalise(st, [0, r, 0, 0], [1.5, -Math.sqrt(2 / r), 0, 0], 'massive');
    const beacon: RayBody = { radius: 0.0005, at: () => ({ pos: [r, 0, 0], u, tau: 0 }) }; // tiny: g depends on where it's emitted
    const end = trace(cam, cameraRay(cam, [-1, 0, 0], uCam), [beacon]);
    expect(end.kind).toBe('body');
    if (end.kind !== 'body') return;
    expect(end.g).toBeCloseTo((1 - Math.sqrt(2 / r)) / Math.sqrt(1 - 2 / 1000), 4);
  });

  it('shows a moving beacon where it was when the light left, not where it is now', () => {
    // Crossing at 0.5c, 100M in front of the camera; it was at y = 0 when t = −100.
    const beacon: RayBody = {
      radius: 2,
      at: (t) => ({ pos: [900, 0.5 * t + 50, 0], u: [1.1547, 0, 0.57735, 0], tau: t / 1.1547 }),
    };
    const retarded = trace(cam, cameraRay(cam, [-1, 0, 0], uCam), [beacon]);
    expect(retarded.kind).toBe('body');
    const n = Math.hypot(100, 50);
    const current = trace(cam, cameraRay(cam, [-100 / n, 50 / n, 0], uCam), [beacon]);
    expect(current.kind).not.toBe('body');
  });
});

describe('beacon worldlines handed to the renderer', () => {
  it('are sampled from the exact geodesic, with properly normalised 4-velocities', async () => {
    const { Beacons } = await import('../src/flight/beacons');
    const { Ship } = await import('../src/physics/ship');
    const { inner } = await import('../src/physics/linalg');
    const hole = new Kerr(1, 0.9);
    const ship = new Ship(hole, [0, -12, 3], [0, 0, 0], [0, 1, 0], [0, 0, 1]);
    const beacons = new Beacons(hole);
    beacons.advanceTo(ship.x[0]);
    const b = beacons.launch(ship, 0.2, 0.5);
    beacons.advanceTo(25); // still falling, well outside the horizon
    expect(hole.radius(b.x)).toBeGreaterThan(3);
    const [frame] = beacons.frames(25, [0, -40, 0], { radius: 0.1, temperature: 8000, pulse: 0 });
    expect(frame.t0).toBeCloseTo(-25, 6); // history starts at launch, 25M ago
    const last = 255;
    // The newest sample is the beacon's live position…
    expect(frame.pos[3 * last]).toBeCloseTo(b.x[1], 5);
    expect(frame.tau[last]).toBeCloseTo(b.tau, 5);
    // …and every sampled 4-velocity is a unit timelike vector at its sample point.
    for (const k of [0, 64, 128, 200, last]) {
      const x: V4 = [0, frame.pos[3 * k], frame.pos[3 * k + 1], frame.pos[3 * k + 2]];
      const u = Array.from(frame.u.subarray(4 * k, 4 * k + 4)) as V4;
      expect(inner(hole.metric(x), u, u)).toBeCloseTo(-1, 6);
    }
    // The direction comes from the worldline itself: compare with the live 4-velocity.
    for (let m = 0; m < 4; m++) expect(frame.u[4 * last + m]).toBeCloseTo(b.u[m], 2);
  });
});
