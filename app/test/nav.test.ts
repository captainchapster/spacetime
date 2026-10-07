import { describe, expect, it } from 'vitest';
import { inner } from '../src/physics/linalg';
import { Kerr } from '../src/physics/metrics/kerr';
import { alignPlatform, boost, lockDirection, navFrame, navState, toBody, toENU, worldToShip } from '../src/physics/nav';
import { Ship } from '../src/physics/ship';

const hole = new Kerr(1, 0.9);
const a = hole.a;

describe('navigation frame and instruments', () => {
  it('builds an orthonormal East–North–Up frame with a ZAMO observer, even inside the ergosphere', () => {
    for (const [x, kind] of [
      [[0, 15, -6, 4], 'zamo'],
      [[0, 1.8, 0.2, 0.1], 'zamo'], // inside the ergosphere, outside the horizon: still fine
      [[0, 1.2, 0.2, 0.1], 'river'], // between the horizons (r ≈ 0.83): no ZAMOs, so the river frame
    ] as const) {
      const f = navFrame(hole, [...x]);
      expect(f.kind).toBe(kind);
      const g = hole.metric([...x]);
      const all = [f.u, f.east, f.north, f.up];
      all.forEach((p, i) => all.forEach((q, j) => expect(inner(g, p, q)).toBeCloseTo(i === j ? (i ? 1 : -1) : 0, 9)));
    }
  });

  it('reads pitch −90° when pointed at a non-spinning hole, and nothing moving while hovering', () => {
    // (By a spinning hole, "toward the centre" isn't exactly "down": its gravity isn't spherical.)
    const still = new Kerr(1, 0);
    const ship = new Ship(still, [0, -20, 0], [0, 0, 0], [0, 1, 0], [0, 0, 1]);
    const n = navState(still, ship);
    expect(n.frame).toBe('zamo'); // which, without spin, simply hovers
    expect(n.pitch).toBeCloseTo(-90, 3);
    expect(n.speed).toBeLessThan(1e-12);
  });

  it('reads level flight heading east, with no vertical speed, on a prograde circular orbit', () => {
    const r = 10;
    const R = Math.sqrt(r * r + a * a);
    const om = 1 / (r ** 1.5 + a);
    // On the +x axis, prograde (counterclockwise) motion is along +y: point that way, roof up.
    const ship = new Ship(hole, [R, 0, 0], [0, om * R, 0], [0, 1, 0], [1, 0, 0]);
    const n = navState(hole, ship);
    expect(n.velocity[2]).toBeCloseTo(0, 9); // no vertical speed
    expect(n.velocity[0]).toBeGreaterThan(0); // moving east, i.e. with the hole's spin
    expect(n.heading).toBeCloseTo(90, 3);
    expect(n.pitch).toBeCloseTo(0, 6);
    expect(n.roll).toBeCloseTo(0, 6);
    // The orbital speed a ZAMO measures (Bardeen, Press & Teukolsky 1972): exact.
    const vBPT = (r * r - 2 * a * Math.sqrt(r) + a * a) / (Math.sqrt(r * r - 2 * r + a * a) * (r ** 1.5 + a));
    expect(n.speed).toBeCloseTo(vBPT, 6);
  });

  it('reads straight down while falling', () => {
    const ship = new Ship(hole, [0, 0, 12], [0, 0, -0.3], [1, 0, 0], [0, 1, 0]); // over the pole
    const n = navState(hole, ship);
    expect(n.velocity[2]).toBeLessThan(0);
    expect(Math.hypot(n.velocity[0], n.velocity[1])).toBeLessThan(1e-9);
  });
});

describe('attitude locks (SAS modes)', () => {
  const dot = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  /** A ship on a tilted, eccentric path, so velocity, up and normal are all distinct. */
  const moving = () => new Ship(hole, [12, -5, 3], [-0.15, 0.25, 0.1], [1, 0, 0], [0, 0, 1]);

  for (const mode of ['prograde', 'retrograde', 'radialIn', 'radialOut', 'normal', 'antinormal'] as const) {
    it(`${mode}: puts that marker dead centre on the navball`, () => {
      const ship = moving();
      for (let i = 0; i < 20; i++) ship.turnToward(hole, lockDirection(hole, ship, mode)!, Math.PI / 4);
      const n = navState(hole, ship);
      const v = n.velocity.map((c) => c / n.speed);
      const normal = [-v[1], v[0], 0].map((c) => c / Math.hypot(v[0], v[1]));
      const want = {
        prograde: v,
        retrograde: v.map((c) => -c),
        radialIn: [0, 0, -1],
        radialOut: [0, 0, 1],
        normal,
        antinormal: normal.map((c) => -c),
      }[mode];
      // Dead centre on the navball.
      expect(toBody(n, want as [number, number, number])[2]).toBeCloseTo(1, 9);
    });
  }

  it('shows aberration exactly: a direction at right angles to your motion appears at cos θ′ = v', () => {
    const ship = moving();
    const n = navState(hole, ship);
    const v = n.velocity.map((c) => c / n.speed);
    const perp = [-v[1], v[0], 0].map((c) => c / Math.hypot(v[0], v[1]));
    const appearsV = worldToShip(n, v as [number, number, number]);
    const appearsPerp = worldToShip(n, perp as [number, number, number]);
    // The direction of motion is the fixed point; the perpendicular one tilts toward it.
    expect(dot(appearsV, appearsPerp)).toBeCloseTo(n.speed, 9);
  });

  it('target: points along the straight line to the target', () => {
    const ship = new Ship(new Kerr(1, 0), [0, -900, 0], [0, 0, 0], [1, 0, 0], [0, 0, 1]); // far out: nearly flat
    const flat = new Kerr(1, 0);
    for (let i = 0; i < 10; i++) ship.turnToward(flat, lockDirection(flat, ship, 'target', [30, -860, 0])!, Math.PI / 2);
    const d = [30, 40, 0].map((c) => c / 50);
    // At 900M the frame is flat to ~0.1%, so East ≈ x and North ≈ z, Up ≈ −y here.
    const f = toENU(flat, ship, ship.e[2])!;
    expect(dot(f, [d[0], 0, -d[1]])).toBeCloseTo(1, 2);
  });

  it('turns no faster than the slew rate, and keeps the ship frame orthonormal', () => {
    const ship = moving();
    const before = toENU(hole, ship, ship.e[2])!;
    ship.turnToward(hole, lockDirection(hole, ship, 'radialOut')!, 0.1);
    const after = toENU(hole, ship, ship.e[2])!;
    expect(Math.acos(Math.min(1, dot(before, after)))).toBeLessThan(0.1 + 1e-9);
    const g = hole.metric(ship.x);
    const all = [ship.u, ...ship.e];
    all.forEach((p, i) => all.forEach((q, j) => expect(inner(g, p, q)).toBeCloseTo(i === j ? (i ? 1 : -1) : 0, 9)));
  });
});

describe('the river frame (space falling inward)', () => {
  const spinning = new Kerr(1, 0.95);

  it('is a unit, future-pointing observer everywhere: outside, between the horizons and inside', () => {
    for (const x of [[0, 12, -5, 3], [0, 1.5, 0.3, 0.2], [0, 1.0, 0.2, 0.1], [0, 0.5, 0.1, 0.05]] as const) {
      const f = navFrame(spinning, [...x], 'river');
      expect(f.kind).toBe('river');
      const g = spinning.metric([...x]);
      expect(inner(g, f.u, f.u)).toBeCloseTo(-1, 9);
      expect(f.u[0]).toBeGreaterThan(0);
    }
  });

  it('reads zero for someone falling in from rest at infinity, through the horizon', () => {
    for (const x of [[0, 10, -4, 2], [0, 1.3, 0.2, 0.1]] as const) {
      // (Built outside, then placed: "at rest" doesn't exist inside the horizon.)
      const ship = new Ship(spinning, [10, -4, 2], [0, 0, 0], [1, 0, 0], [0, 0, 1]);
      ship.x = [...x];
      ship.u = navFrame(spinning, ship.x, 'river').u; // move with the river
      ship.orient(spinning, ship.attitude().forward, ship.attitude().up);
      expect(navState(spinning, ship, 'river').speed).toBeLessThan(1e-9);
    }
  });

  it('reads the escape speed √(2M/r), upward, for a ship hovering near a non-spinning hole', () => {
    const still = new Kerr(1, 0);
    const r = 8;
    const ship = new Ship(still, [r, 0, 0], [0, 0, 0], [0, 1, 0], [1, 0, 0]);
    const n = navState(still, ship, 'river');
    expect(n.speed).toBeCloseTo(Math.sqrt(2 / r), 9);
    expect(n.velocity[2]).toBeCloseTo(Math.sqrt(2 / r), 9); // all of it upward, against the flow
  });

  it('gives a falling ship a reading that changes smoothly across the horizon', () => {
    const ship = new Ship(spinning, [0, -40, 6], [0, 0, 0], [0, 1, 0], [0, 0, 1]);
    const readings: [number, number][] = [];
    while (spinning.radius(ship.x) > 1.0) {
      ship.step(spinning, 0.01, [0, 0, 0]);
      const r = spinning.radius(ship.x);
      if (r < 1.5) readings.push([r, navState(spinning, ship, 'river').speed]);
    }
    // No jumps between consecutive readings as the ship crosses r₊ ≈ 1.31.
    for (let i = 1; i < readings.length; i++) expect(Math.abs(readings[i][1] - readings[i - 1][1])).toBeLessThan(0.01);
    // Released at 40M (not infinity), it falls a little slower than the river: a small upward reading.
    expect(readings[0][1]).toBeLessThan(0.3);
  });
});

describe('the stationary (far-away) reference', () => {
  const spinning = new Kerr(1, 0.95);

  it('reads zero for a ship hovering at rest relative to the far-away universe', () => {
    const ship = new Ship(spinning, [0, -12, 3], [0, 0, 0], [0, 1, 0], [0, 0, 1]);
    const n = navState(spinning, ship, 'static');
    expect(n.frame).toBe('static');
    expect(n.speed).toBeLessThan(1e-12);
  });

  it('agrees with the ship\'s own speed relative to a hovering observer', () => {
    const ship = new Ship(spinning, [0, -40, 6], [0, 0, 0], [0, 1, 0], [0, 0, 1]);
    while (spinning.radius(ship.x) > 3) ship.step(spinning, 0.02, [0, 0, 0]);
    expect(navState(spinning, ship, 'static').speed).toBeCloseTo(ship.relativeToStatic(spinning)!.speed, 9);
  });

  it('falls back where a stationary observer is impossible, and says which it used', () => {
    // Inside the ergosphere (equator, r ≈ 1.8 > r₊): co-rotating hold-still.
    const ergo = navFrame(spinning, [0, Math.sqrt(1.8 * 1.8 + 0.95 * 0.95), 0, 0], 'static');
    expect(ergo.kind).toBe('zamo');
    // Inside the horizon: the river.
    expect(navFrame(spinning, [0, 1.2, 0.2, 0.1], 'static').kind).toBe('river');
  });
});

describe('the navball is a rigid instrument', () => {
  const fast = () => new Ship(hole, [6, -3, 1], [-0.5, 0.6, 0.2], [1, 0, 0], [0, 0, 1]);

  it('boosts the reference observer exactly onto the ship, keeping their axes orthonormal', () => {
    const ship = fast();
    const f = navFrame(hole, ship.x, 'zamo');
    const g = hole.metric(ship.x);
    const bu = boost(g, f.u, ship.u, f.u);
    bu.forEach((c, k) => expect(c).toBeCloseTo(ship.u[k], 9));
    const axes = [f.east, f.north, f.up].map((a) => boost(g, f.u, ship.u, a));
    axes.forEach((p, i) => {
      expect(inner(g, p, ship.u)).toBeCloseTo(0, 9);
      axes.forEach((q, j) => expect(inner(g, p, q)).toBeCloseTo(i === j ? 1 : 0, 9));
    });
  });

  it('is a rotation matrix at any speed: the ball never deforms', () => {
    const n = navState(hole, fast(), 'zamo');
    expect(n.speed).toBeGreaterThan(0.6);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const d = n.ball[i][0] * n.ball[j][0] + n.ball[i][1] * n.ball[j][1] + n.ball[i][2] * n.ball[j][2];
        expect(d).toBeCloseTo(i === j ? 1 : 0, 9);
      }
  });

  it('keeps flying on gyros when the reference is lost: turns still show, nothing else moves it', () => {
    const spinning = new Kerr(1, 0.95);
    // Static reference, released just outside the ergosphere: the platform is aligned there.
    const ship = new Ship(spinning, [2.3, 0, 0.05], [0, 0, 0], [0, 1, 0], [1, 0, 0]);
    expect(alignPlatform(spinning, ship, 'static')).toBe(true);
    while (navFrame(spinning, ship.x, 'static').valid) {
      ship.step(spinning, 0.01, [0, 0, 0]);
      alignPlatform(spinning, ship, 'static');
    }
    const lost = navState(spinning, ship, 'static');
    expect(lost.valid).toBe(false);
    // Falling on with no reference: the ball reads the same (gyros and hull share their transport).
    ship.step(spinning, 0.05, [0, 0, 0]);
    expect(alignPlatform(spinning, ship, 'static')).toBe(false);
    const later = navState(spinning, ship, 'static');
    later.ball.forEach((row, k) => row.forEach((c, i) => expect(c).toBeCloseTo(lost.ball[k][i], 9)));
    // Yaw the ship 30°: the nose sweeps 30° across the frozen ball.
    ship.rotate(1, (30 * Math.PI) / 180);
    const turned = navState(spinning, ship, 'static');
    const cos = turned.forward.reduce((s, c, k) => s + c * later.forward[k], 0);
    expect((Math.acos(cos) * 180) / Math.PI).toBeCloseTo(30, 6);
    // And through orient() (what SAS uses), the gyros are untouched too.
    const axes = ship.platformAxes();
    ship.turnToward(spinning, ship.e[1], 0.4);
    const after = ship.platformAxes();
    const g = spinning.metric(ship.x);
    axes.forEach((a, k) => expect(inner(g, a, after[k])).toBeCloseTo(1, 9));
  });
});
