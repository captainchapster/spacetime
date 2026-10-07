import { Minkowski } from './physics/metrics/minkowski';
import { Schwarzschild } from './physics/metrics/schwarzschild';
import { boundOrbit, circularOrbitSpeed } from './physics/orbits';
import type { Spacetime } from './physics/spacetime';
import type { Vec3, World } from './physics/world';
import type { LayerSettings } from './view/spacetimeView';
import type { AxisSet } from './view/projection';

export interface ScenarioView extends LayerSettings {
  axes: AxisSet;
  slice: number;
  timeScale: number;
  boost: number;
  /** Coordinate time per real second. */
  speed: number;
  /** Inner edge of the time-warp embedding (its outer edge is `extent`). */
  embedInner: number;
  /** Embedding shape: smaller flares harder toward the mass but wraps time faster. */
  embedFlare: number;
}

export interface Scenario {
  label: string;
  description: string;
  units: string;
  spacetime: () => Spacetime;
  setup: (world: World) => void;
  view: Partial<ScenarioView>;
  /** Initial camera, in display coordinates, if the default framing doesn't show the point. */
  camera?: { position: Vec3; target: Vec3 };
}

export const DEFAULT_VIEW: ScenarioView = {
  axes: 'txy',
  slice: 0,
  timeScale: 1,
  boost: 0,
  speed: 5,
  window: 40,
  extent: 15,
  worldlines: true,
  tickInterval: 2,
  properTimeTicks: true,
  lightCones: true,
  coneSpacing: 5,
  clocks: false,
  clockSpacing: 3,
  fieldGrid: true,
  horizon: true,
  dustSnapshots: 5,
  embedInner: 5,
  embedFlare: 0.25,
};

/** Rotate a vector about the z axis. */
function rot([x, y, z]: Vec3, deg: number): Vec3 {
  const a = (deg * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z];
}

const M = 1;

export const SCENARIOS: Record<string, Scenario> = {
  flat: {
    label: 'Flat spacetime (special relativity)',
    units: 'units (c = 1)',
    description:
      'No gravity: free bodies have straight worldlines and every light cone is an upright 45° cone. ' +
      'Dots on worldlines mark equal intervals of each body\'s own proper time: faster bodies tick less often. ' +
      'Slide the boost to view everything from a moving frame and watch "now" stop being flat.',
    spacetime: () => new Minkowski(),
    setup: (w) => {
      w.addParticle([0, 0, 0], [0, 0, 0], { label: 'at rest' });
      w.addParticle([-12, -4, 0], [0.6, 0, 0], { label: '0.6c' });
      w.addParticle([8, -8, 0], [-0.3, 0.4, 0], { label: '0.5c' });
      w.addParticle([-4, 12, 0], [0, -0.9, 0], { label: '0.9c' });
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        w.addPhoton([0, 0, 0], [Math.cos(a), Math.sin(a), 0]);
      }
    },
    view: { speed: 4, window: 30, extent: 15, coneSpacing: 6, horizon: false },
  },

  orbits: {
    label: 'Black hole: orbits',
    units: 'GM/c²',
    description:
      'A Schwarzschild black hole (horizon at r = 2M). In (ct, x, y) orbits become helices. ' +
      'The ellipse (8M–20M) precesses by about 165° per orbit (Mercury manages 0.1″). ' +
      'The r = 6M orbit is the innermost stable one and eventually drifts off. ' +
      'Light can orbit at r = 3M, but unstably: it soon peels away. One body falls straight in.',
    spacetime: () => new Schwarzschild(M),
    setup: (w) => {
      w.addParticle([10, 0, 0], [0, circularOrbitSpeed(M, 10), 0], { label: 'circular r=10M' });
      w.addParticle(rot([8, 0, 0], 90), rot([0, boundOrbit(M, 8, 20).speed, 0], 90), { label: 'precessing' });
      w.addParticle(rot([6, 0, 0], 200), rot([0, circularOrbitSpeed(M, 6), 0], 200), { label: 'ISCO r=6M' });
      w.addParticle(rot([16, 0, 0], 300), [0, 0, 0], { label: 'radial infall' });
      w.addPhoton([3, 0, 0], [0, 1, 0], { label: 'photon sphere' });
    },
    view: {
      speed: 25,
      window: 220,
      timeScale: 0.3,
      extent: 22,
      lightCones: false,
      tickInterval: 10,
    },
  },

  dust: {
    label: 'Black hole: falling dust grid',
    units: 'GM/c²',
    description:
      'A sheet of dust released at rest. Each node follows its own geodesic, so the grid lines are ' +
      'the spacetime grid made physical: they converge (gravity) and stretch radially while ' +
      'squeezing sideways (tidal curvature, i.e. spaghettification). ' +
      'The static clocks tick slower (bluer, wider-spaced) closer to the hole: that time warp is what bends the worldlines.',
    spacetime: () => new Schwarzschild(M),
    setup: (w) => {
      w.addDustGrid([14, 0, 0], 1, 2, 7, 7, 1.5);
    },
    view: {
      speed: 6,
      window: 80,
      timeScale: 0.5,
      extent: 16,
      lightCones: false,
      clocks: true,
      clockSpacing: 4,
      tickInterval: 4,
      properTimeTicks: false,
      dustSnapshots: 6,
    },
  },

  timewarp: {
    label: 'Black hole: time-warp surface',
    units: 'GM/c²',
    description:
      'The (t, r) plane drawn as a curved surface (after Jonsson, 2005) on which every radial free fall is a ' +
      'straight line. Time runs around the surface and r runs down it. Clocks near the mass tick slower, ' +
      'which here makes the surface wider. Bodies released at rest start out moving purely through time, ' +
      'along a circle, yet a straight line drawn that way drifts toward the wide end: they fall. ' +
      'The thrown body (pink) rises and falls back along one straight line. ' +
      'Exact for radial motion; switch to (ct, x, y) to see the same bodies conventionally.',
    spacetime: () => new Schwarzschild(M),
    setup: (w) => {
      [8, 11, 14, 18].forEach((r, i) => w.addParticle(rot([r, 0, 0], i * 90), [0, 0, 0], { label: `rest at ${r}M` }));
      w.addParticle(rot([7, 0, 0], 45), rot([0.3, 0, 0], 45), { color: 0xff7aa8, label: 'thrown up' });
      w.addPhoton(rot([5.5, 0, 0], 225), rot([1, 0, 0], 225), { label: 'outgoing light' });
    },
    view: {
      axes: 'embed',
      speed: 5,
      window: 200,
      extent: 22,
      clocks: true,
      clockSpacing: 3,
      tickInterval: 4,
      lightCones: false,
    },
  },

  lensing: {
    label: 'Black hole: bending light',
    units: 'GM/c²',
    description:
      'Parallel light rays passing the hole. Rays aimed closer than b = 3√3 M ≈ 5.2M are captured; ' +
      'the rest are deflected, some looping almost all the way around. ' +
      'The amber ellipsoids show where light from each point gets to a moment later: near the hole ' +
      'they shrink and shift inward, the local "speed limit" being dragged toward it.',
    spacetime: () => new Schwarzschild(M),
    setup: (w) => {
      for (let b = -12; b <= 12.01; b += 1.5) w.addPhoton([-30, b, 0], [1, 0, 0]);
      w.addPhoton([-30, 5.3, 0], [1, 0, 0], { color: 0xff7aa8, label: 'just outside 3√3 M' });
    },
    view: {
      axes: 'xyz',
      speed: 12,
      window: 90,
      extent: 30,
      coneSpacing: 6,
    },
  },

  sandbox: {
    label: 'Black hole: light cones (sandbox)',
    units: 'GM/c²',
    description:
      'An empty black hole, seen in (ct, x, y). Far away light cones are upright 45° cones, as in flat ' +
      'spacetime. Closer in they narrow and tip toward the hole, and inside the horizon (red) they ' +
      'tip so far that every future direction leads inward: that is what a horizon is. ' +
      'Shift+click to drop bodies or light rays (set kind and velocity under "Add body").',
    spacetime: () => new Schwarzschild(M),
    setup: () => {},
    view: { speed: 4, window: 30, extent: 10, coneSpacing: 2, tickInterval: 2 },
    camera: { position: [3, 5, 19], target: [0, 0, 0] },
  },
};
