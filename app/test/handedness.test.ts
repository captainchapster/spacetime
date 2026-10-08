import { describe, expect, it } from 'vitest';
import { decayBrake, iscoRadius } from '../src/physics/disk';
import { inner } from '../src/physics/linalg';
import { Kerr } from '../src/physics/metrics/kerr';
import { lockDirection } from '../src/physics/nav';
import { Ship } from '../src/physics/ship';

/** Sign of det[u; right; up; forward] (component matrix): the frame's handedness. */
function handedness(ship: Ship) {
  const m = [ship.u, ...ship.e].map((v) => [...v]);
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

describe('the ship frame', () => {
  it('never turns into its mirror image (the decaying spiral, nose locked radially in, past the ergosphere)', () => {
    // As in the game's "Spiral in" start: where the view once flipped left for right.
    const a = 0.95;
    const hole = new Kerr(1, a);
    const isco = iscoRadius(a);
    const r0 = isco + 6;
    const A = decayBrake(a, r0, 10);
    const th = (85 * Math.PI) / 180;
    const R = Math.sqrt(r0 * r0 + a * a);
    const pos: [number, number, number] = [0, -R * Math.sin(th), r0 * Math.cos(th)];
    const om = 1 / (r0 ** 1.5 + a);
    const ship = new Ship(hole, pos, [-om * pos[1], om * pos[0], 0], pos.map((c) => -c) as [number, number, number], [0, 0, 1]);
    const brake = (s: Ship): [number, number, number] => {
      if (hole.radius(s.x) <= isco) return [0, 0, 0];
      const d = lockDirection(hole, s, 'retrograde', undefined, 'zamo');
      if (!d) return [0, 0, 0];
      const g = hole.metric(s.x);
      const c = s.e.map((e) => inner(g, d, e));
      const n = Math.hypot(...c);
      return c.map((q) => (A * q) / n) as [number, number, number];
    };
    const start = handedness(ship);
    let flips = 0;
    while (hole.radius(ship.x) > 2.0 && !ship.crushed) {
      ship.step(hole, 0.5, brake, 400);
      const aim = lockDirection(hole, ship, 'radialIn', undefined, 'static');
      if (aim) ship.turnToward(hole, aim, Math.PI);
      if (handedness(ship) !== start) flips++;
    }
    expect(flips).toBe(0);
  });
});
