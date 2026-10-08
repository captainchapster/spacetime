import GUI from 'lil-gui';
import { blackbodyRgb } from '../physics/blackbody';
import { type DiskModel, decayBrake, diskModel, iscoRadius, polarIsso } from '../physics/disk';
import { type Vec4, inner } from '../physics/linalg';
import { Kerr } from '../physics/metrics/kerr';
import { type LockMode, type Reference, type V3, alignPlatform, bodyDirection, lockDirection, navState, worldToShip } from '../physics/nav';
import { Ship, type Vec3 } from '../physics/ship';
import {
  formatDistance,
  formatDuration,
  geometricToG,
  gravitationalRadius,
  gravitationalTime,
  gToGeometric,
} from '../physics/units';
import { Ambience } from './audio';
import { Beacons } from './beacons';
import { type Caption, type Fate, Story, epilogue } from './story';
import { type HomeSignal, homeSignal, sampleView, sightBeacon, tidalAcceleration, type ViewSample } from '../physics/observe';
import { installTooltips, tip } from './tooltip';
import { loadRealSky, skyMatrix } from './realSky';
import { NavHud } from './navHud';
import { PhotoMode } from './photo';
import { type FrameParams, Renderer, TABLE_N } from './renderer';

// ---------------------------------------------------------------- black holes

interface HolePreset {
  label: string;
  mass: number; // solar masses
  spin: number;
  /** log10 of the accretion rate as a fraction of Eddington. */
  logEddington: number;
}

const HOLES: Record<string, HolePreset> = {
  gargantua: { label: 'Gargantua-like · 10⁸ M☉', mass: 1e8, spin: 0.95, logEddington: -6.5 },
  sgrA: { label: 'Sagittarius A* · 4.3×10⁶ M☉', mass: 4.3e6, spin: 0.9, logEddington: -7 },
  m87: { label: 'M87* · 6.5×10⁹ M☉', mass: 6.5e9, spin: 0.9, logEddington: -5 },
  stellar: { label: 'Stellar · 10 M☉', mass: 10, spin: 0.7, logEddington: -1 },
};

/** The ship's length (metres), and the tidal stretch across it (g) at which the hull fails. */
const SHIP_LENGTH_M = 100;
const HULL_LIMIT_G = 1000;
/** No start puts the ship where the tidal stretch is more than this (g). */
const SAFE_START_G = 10;

// ---------------------------------------------------------------- starting positions

interface Start {
  label: string;
  /** Position given as (r, polar angle from +z in degrees, azimuth in degrees). */
  r: number;
  /**
   * If set, r is this far outside the innermost stable orbit instead (the equatorial ISCO,
   * or for a polar orbit the polar one), so the start suits any spin.
   */
  fromIsco?: number;
  theta: number;
  phi: number;
  hover: boolean;
  /**
   * Initial velocity: none, or a circular-ish orbit about the given axis. 'decay' is a
   * prograde orbit with the retro-brake on, so it winds down and spirals in; 'polarDecay'
   * the same over the poles.
   */
  orbit?: 'equatorial' | 'polar' | 'decay' | 'polarDecay';
  /** Attitude mode to start in (default: hold). */
  attitude?: LockMode;
  /** Drop a beacon just ahead of the ship at the start. */
  beacon?: boolean;
}

const STARTS: Record<string, Start> = {
  beside: { label: 'Beside the disk', r: 28, theta: 84, phi: -90, hover: true },
  experiment: { label: 'Beacon experiment', r: 20, theta: 78, phi: -90, hover: true, beacon: true },
  pole: { label: 'Above the pole', r: 30, theta: 2, phi: -90, hover: true },
  polar: { label: 'Polar orbit (14M)', r: 14, theta: 90, phi: -90, hover: false, orbit: 'polar' },
  plunge: { label: 'Plunge from 40M', r: 40, theta: 80, phi: -90, hover: false },
  spiral: {
    label: 'Spiral in: decaying orbit',
    r: 0,
    fromIsco: 6,
    theta: 85,
    phi: -90,
    hover: false,
    orbit: 'decay',
    attitude: 'radialIn',
  },
  drop: { label: 'Drop in: from rest, same spot', r: 0, fromIsco: 6, theta: 85, phi: -90, hover: false, attitude: 'radialIn' },
  spiralPolar: {
    label: 'Spiral in: decaying polar orbit',
    r: 0,
    fromIsco: 6,
    theta: 90,
    phi: -90,
    hover: false,
    orbit: 'polarDecay',
    attitude: 'radialIn',
  },
  distant: { label: 'Far out (600M)', r: 600, theta: 82, phi: -90, hover: true },
};

// ---------------------------------------------------------------- attitude modes

const SAS_MODES: { mode: LockMode; key: string; label: string; short: string; icon: string }[] = [
  { mode: 'hold', key: '1', label: 'Hold attitude', short: 'Hold', icon: '⊙' },
  { mode: 'prograde', key: '2', label: 'Prograde', short: 'Prograde', icon: '⊕' },
  { mode: 'retrograde', key: '3', label: 'Retrograde', short: 'Retrograde', icon: '⊗' },
  { mode: 'radialIn', key: '4', label: 'Radial in (toward the hole)', short: 'Radial in', icon: '◉' },
  { mode: 'radialOut', key: '5', label: 'Radial out (away from the hole)', short: 'Radial out', icon: '◎' },
  { mode: 'normal', key: '6', label: 'Orbit normal', short: 'Normal', icon: '▲' },
  { mode: 'antinormal', key: '7', label: 'Orbit anti-normal', short: 'Anti-normal', icon: '▼' },
  { mode: 'target', key: '8', label: 'Target (T to cycle)', short: 'Target', icon: '◇' },
  { mode: 'free', key: '0', label: 'Free gyroscope', short: 'Free', icon: '○' },
];

// ---------------------------------------------------------------- time warp

/** "×1,000", "×1/100": a power of ten as a readable warp factor. */
function warpLabel(log: number) {
  const n = Math.round(log);
  if (n === 0) return '×1 (real time)';
  const big = (10 ** Math.abs(n)).toLocaleString('en-US');
  return n > 0 ? `×${big}` : `×1/${big} (slow-mo)`;
}
const WARPS = Object.fromEntries(Array.from({ length: 14 }, (_, i) => i - 6).map((n) => [warpLabel(n), n]));

// ---------------------------------------------------------------- state

const settings = {
  hole: 'gargantua',
  mass: HOLES.gargantua.mass,
  spin: HOLES.gargantua.spin,
  logEddington: HOLES.gargantua.logEddington,
  diskOn: true,
  diskOuter: 14,
  turbulence: 0.65,
  shifts: true,
  start: 'beside',
  thrustG: 1,
  logWarp: 3,
  hover: true,
  /** Retro-brake: thrust gently against the orbital motion, so the orbit winds down. */
  brake: false,
  /** Brake strength, as the number of orbits it takes to wind down to the ISCO. */
  brakeTurns: 10,
  sound: true,
  volume: 0.6,
  captions: true,
  cinematic: false,
  drift: false,
  grain: 0,
  vignette: 1,
  /** Show the view behind the ship (a rear camera; the ship itself doesn't turn). */
  rearView: false,
  attitude: 'hold' as LockMode,
  /** What speeds and directions on the instruments are measured against. */
  reference: 'static' as Reference,
  /** Index into the beacon list of the current target, or −1. */
  target: -1,
  paused: false,
  fov: 60,
  exposureEV: 0,
  autoExposure: true,
  sky: 0 as 0 | 1 | 2,
  /** Orientation of the real sky around the hole (degrees). */
  skyYaw: 0,
  skyTilt: 25,
  bloom: 0.035,
  starGain: 1,
  galaxyGain: 1,
  renderScale: 0.6,
  /** Lower the resolution (never above renderScale) when frames take too long. */
  adaptiveRes: true,
  quality: 'high' as 'draft' | 'high' | 'ultra',
  beaconSpeed: 0,
  beaconRadius: 0.12,
  beaconTemperature: 15000,
  beaconPulse: 20,
};

const QUALITY = {
  draft: { maxSteps: 350, stepScale: 0.06 },
  high: { maxSteps: 900, stepScale: 0.03 },
  ultra: { maxSteps: 2500, stepScale: 0.012 },
};

const canvas = document.getElementById('view') as HTMLCanvasElement;
let renderer: Renderer;
try {
  renderer = new Renderer(canvas);
} catch (e) {
  const el = document.getElementById('error')!;
  el.style.display = 'flex';
  el.textContent = (e as Error).message;
  throw e;
}

let hole = new Kerr(1, settings.spin);
let disk: DiskModel;
let ship: Ship;
let beacons: Beacons;
// Journey state for the captions, beacon pings and ending (reset with the ship).
const story = new Story();
/** Per beacon: where it was last seen in the ship frame, and the last blink heard. */
const sightings = new Map<number, { dir: [number, number, number] | null; blink: number }>();
let ended = false;
const captionEl = document.getElementById('caption')!;
const captionQueue: Caption[] = [];
let captionTimers: number[] = [];
/** The caption on screen, and when it appeared. */
let captionNow: { caption: Caption; since: number } | null = null;
/** Where the hover autopilot holds the ship (re-set whenever the pilot stops thrusting). */
let hoverAnchor: Vec3 | null = null;
/** Retro-brake strength (proper acceleration, units 1/M), and whether it fired last step. */
let brakeA = 0;
let braking = false;
let wasBraking = false;
/** Whether the braked orbit is polar (rather than equatorial and prograde). */
let brakePolar = false;

/** Where the retro-brake stops: the innermost stable orbit of the kind being flown. */
function brakeFloor() {
  return brakePolar ? polarIsso(hole.a) : iscoRadius(hole.a);
}

/**
 * Set the retro-brake so the orbit winds down from where the ship is now to the innermost
 * stable orbit in about settings.brakeTurns orbits (see decayBrake). A polar orbit feels
 * the spin far less, so it's treated like a non-spinning hole's orbit at the same height
 * above its floor (checked against full integrations in test/decay.test.ts).
 */
function updateBrake() {
  const floor = brakeFloor();
  const r = Math.max(hole.radius(ship.x), floor + 0.05);
  brakeA = brakePolar ? decayBrake(0, 6 + (r - floor), settings.brakeTurns) : decayBrake(hole.a, r, settings.brakeTurns);
}
/** The coordinate directions the reaction wheels keep the ship pointing (attitude hold). */
/**
 * Attitude hold: the navball reading to hold, as the ball matrix (local East, North, Up along
 * the ship's axes). Like a real attitude-hold autopilot it holds heading, pitch and roll
 * relative to the local frame, so it needs the navigation solution. Null: take the current
 * reading on the next frame.
 */
let heldBall: number[][] | null = null;
/** Set when the autopilot lets go because the navigation solution failed (for the caption). */
let autopilotLetGo = false;

/** Hold whatever the navball reads now (if it reads anything). */
function captureHold() {
  const n = navState(hole, ship, settings.reference);
  heldBall = n.valid ? n.ball.map((row) => [...row]) : null;
}

/** Turn the ship back to the held navball reading, given the current (valid) one. */
function applyHold(ball: number[][]) {
  if (!heldBall) return;
  const held = heldBall;
  // The local East, North, Up as 4-vectors, from the current reading.
  const axes = ball.map((row) => [0, 1, 2, 3].map((m) => row[0] * ship.e[0][m] + row[1] * ship.e[1][m] + row[2] * ship.e[2][m]));
  // The ship's axes that would give the held reading.
  const axis = (i: number) => [0, 1, 2, 3].map((m) => held[0][i] * axes[0][m] + held[1][i] * axes[1][m] + held[2][i] * axes[2][m]) as Vec4;
  ship.orient(hole, axis(2), axis(1));
}
/** Luminance of a blackbody at the disk's peak temperature: the exposure reference. */
let referenceLuminance = 1;

const LOG2_T: [number, number] = [Math.log2(300), Math.log2(3e7)];
const blackbodyTable = (() => {
  const out = new Float32Array(TABLE_N * 3);
  for (let i = 0; i < TABLE_N; i++) {
    const T = 2 ** (LOG2_T[0] + ((LOG2_T[1] - LOG2_T[0]) * i) / (TABLE_N - 1));
    blackbodyRgb(T).forEach((v, c) => (out[i * 3 + c] = Math.log2(Math.max(v, 1e-30))));
  }
  return out;
})();

function luminanceOf(T: number) {
  const [r, g, b] = blackbodyRgb(T);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rebuildHole() {
  hole = new Kerr(1, settings.spin);
  disk = diskModel(settings.mass, settings.spin, 10 ** settings.logEddington, settings.diskOuter, TABLE_N);
  renderer.setTables(blackbodyTable, LOG2_T, Float32Array.from(disk.T));
  referenceLuminance = luminanceOf(Math.max(disk.Tmax, 1500));
}

function resetShip() {
  const s = STARTS[settings.start];
  const th = (s.theta * Math.PI) / 180;
  const ph = (s.phi * Math.PI) / 180;
  // Kerr–Schild position for spheroidal radius r at angles (θ, φ).
  const a = hole.a;
  brakePolar = s.orbit === 'polarDecay';
  let r0 = s.fromIsco !== undefined ? brakeFloor() + s.fromIsco : s.r;
  // Near a small hole the tides at the usual starting points would tear the ship apart at
  // once (and again on every restart). Tidal stretch falls off as 1/r³, so move straight
  // out to where it's survivable.
  const tides = tidalAcceleration(r0, SHIP_LENGTH_M, gravitationalRadius(settings.mass));
  const movedFrom = tides > SAFE_START_G ? r0 : null;
  if (movedFrom !== null) r0 *= Math.cbrt(tides / SAFE_START_G);
  const rho = Math.sqrt(r0 * r0 + a * a);
  const pos: Vec3 = [rho * Math.sin(th) * Math.cos(ph), rho * Math.sin(th) * Math.sin(ph), r0 * Math.cos(th)];
  const n = Math.hypot(...pos);
  const forward: Vec3 = [-pos[0] / n, -pos[1] / n, -pos[2] / n];
  const up: Vec3 = Math.abs(forward[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1];
  let vel: Vec3 = [0, 0, 0];
  if (s.orbit === 'polar') vel = [0, 0, Math.sqrt(1 / r0) * 0.98];
  if (s.orbit === 'polarDecay') vel = [0, 0, Math.sqrt(1 / r0)]; // over the poles, near circular
  if (s.orbit === 'equatorial' || s.orbit === 'decay') {
    const om = 1 / (r0 ** 1.5 + a);
    vel = [-om * pos[1], om * pos[0], 0];
  }
  ship = new Ship(hole, pos, vel, forward, up);
  settings.hover = s.hover;
  settings.brake = s.orbit === 'decay' || s.orbit === 'polarDecay';
  updateBrake();
  settings.attitude = s.attitude ?? 'hold';
  hoverAnchor = null;
  heldBall = null;
  beacons = new Beacons(hole);
  beacons.advanceTo(ship.x[0]);
  story.reset();
  sightings.clear();
  hideEpilogue();
  if (movedFrom !== null) {
    showCaption({
      text: `Near a hole this small, tides at ${movedFrom.toFixed(0)}M would tear the ship apart at once, so you start further out, at ${r0.toFixed(0)}M, where they stretch the hull by ${SAFE_START_G} g. They grow eightfold each time you halve your distance; the hull fails at ${HULL_LIMIT_G} g.`,
      landmark: false,
      keep: true,
    });
  }
  if (s.beacon) {
    beacons.launch(ship, 0, 1.2);
    settings.logWarp = Math.round(Math.log10(gravitationalTime(settings.mass) * 20)); // ~20M per second: a blink a second
  }
}

rebuildHole();
resetShip();

// ---------------------------------------------------------------- GUI

installTooltips();
const gui = new GUI({ title: 'Black hole flight', width: 290 });
const refresh = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());

const fHole = gui.addFolder('Black hole');
tip(
  fHole
    .add(settings, 'hole', Object.fromEntries(Object.entries(HOLES).map(([k, h]) => [h.label, k])))
    .name('Preset')
    .onChange((k: string) => {
      const h = HOLES[k];
      Object.assign(settings, { mass: h.mass, spin: h.spin, logEddington: h.logEddington });
      settings.logWarp = Math.round(Math.log10(gravitationalTime(h.mass) * 2));
      rebuildHole();
      resetShip();
      refresh();
    }),
  'Real black holes and their masses. Mass sets the real-world scale (km, hours, g-forces); the shape of everything is the same in units of M.',
);
tip(
  fHole.add(settings, 'spin', 0, 0.998, 0.001).name('Spin').onFinishChange(() => {
    rebuildHole();
    resetShip();
  }),
  'Spin a/M, from 0 (not rotating) toward 1 (maximal). More spin: a smaller, lopsided shadow, an inner disk edge closer in, and stronger frame dragging.',
);
tip(
  fHole.add(settings, 'logEddington', -10, 0, 0.1).name('Accretion rate').onChange(rebuildHole),
  'How fast gas falls in, as log₁₀ of the Eddington rate (the rate whose light would balance gravity). Higher means a hotter, brighter disk. The HUD shows the resulting peak temperature.',
);
tip(
  fHole.add(settings, 'diskOuter', 6, 60, 1).name('Disk size').onChange(rebuildHole),
  'Outer radius of the accretion disk, in M. The inner edge is fixed by physics: the innermost stable circular orbit (ISCO).',
);
tip(fHole.add(settings, 'diskOn').name('Accretion disk'), 'Show the glowing disk of gas orbiting the hole.');
tip(
  fHole.add(settings, 'turbulence', 0, 1, 0.01).name('Disk texture'),
  'Brightness variations swirling with the gas (artistic). The pattern orbits at the real speed for each radius, seen with light-travel delay.',
);
tip(
  fHole.add(settings, 'shifts').name('Doppler & redshift'),
  'On: the physically correct view, with the approaching side of the disk brighter and bluer and gravitational redshift near the hole. Off: the symmetric look used in the film Interstellar (unphysical).',
);

const fShip = gui.addFolder('Ship');
tip(
  fShip
    .add(settings, 'start', Object.fromEntries(Object.entries(STARTS).map(([k, s]) => [s.label, k])))
    .name('Start')
    .onChange(() => {
      resetShip();
      refresh();
    }),
  'Where to begin: hovering beside the disk or above a pole, in a polar orbit, released to plunge in, far away, or the beacon experiment (a blinking beacon dropped into the hole). To compare ways in: "Spiral in" starts on an orbit that winds down until it plunges, like the disk\'s gas; "Drop in" starts at the same spot from rest and falls straight in; the polar spiral winds down over the poles instead.',
);
tip(fShip.add({ restart: resetShip }, 'restart').name('Restart here'), 'Start the chosen scenario again.');
tip(
  fShip.add(settings, 'thrustG', 0.01, 1e4, 0.01).name('Engine (g)'),
  'Thrust in g (Earth gravities). Hovering near a supermassive hole takes tens of g or more, so fictional engines are allowed. Shift multiplies it by 10.',
);
tip(
  fShip.add(settings, 'brake').name('Retro-brake'),
  'Thrust gently against your orbital motion, so the orbit winds down and you spiral in. In reality orbits decay only by gravitational waves, far too slowly to watch, so this stands in for them (a fictional engine near a giant hole). It cuts out at the ISCO, below which nothing can orbit anyway.',
);
tip(
  fShip
    .add(settings, 'brakeTurns', 3, 40, 1)
    .name('Brake: orbits to ISCO')
    .onChange(() => updateBrake()),
  'Brake strength, as about how many orbits it takes to wind down from here to the ISCO.',
);
tip(
  fShip.add(settings, 'hover').name('Hover autopilot').onChange(() => (hoverAnchor = null)),
  'H: fire the engines to hold your position against gravity. Impossible inside the ergosphere, where space itself is dragged around faster than light could resist.',
);
tip(
  fShip
    .add(settings, 'attitude', Object.fromEntries(SAS_MODES.map((m) => [`${m.key} · ${m.short}`, m.mode])))
    .name('Attitude')
    .onChange((m: LockMode) => setAttitude(m)),
  'Where the reaction wheels point the ship (keys 1–8, 0; or the buttons above the navball). Turning by hand drops back to Hold.',
);
tip(
  fShip.add(settings, 'logWarp', WARPS).name('Time warp'),
  'How fast your own clock runs compared with real time (keys , and .). Slow motion is useful near small black holes, where everything happens in milliseconds.',
);
tip(fShip.add(settings, 'paused').name('Paused'), 'P: freeze time. You can still look around.');
tip(
  fShip
    .add(settings, 'reference', {
      'Stationary (far-away frame)': 'static',
      'Co-rotating hold-still (ZAMO)': 'zamo',
      'Falling space (river)': 'river',
    })
    .name('Speed relative to'),
  'Speed is always relative to someone. Stationary: at rest relative to the far-away universe (impossible inside the ergosphere: the navigation computer loses its reference and the ball runs on gyros). Co-rotating: holding position while turning with the dragged space (impossible inside the horizon). River: space falling inward at the escape speed; drifting with it reads 0, even through the horizon.',
);
tip(
  fShip.add(settings, 'rearView').name('Look back'),
  'V: show the view behind you without turning the ship. Inside the horizon, the outside universe is behind you.',
);

const dropBeacon = () => {
  beacons.launch(ship, settings.beaconSpeed, 3 * settings.beaconRadius);
  settings.target = beacons.list.length - 1; // the newest beacon becomes the target
};
const fBeacon = gui.addFolder('Beacons');
tip(
  fBeacon.add({ drop: dropBeacon }, 'drop').name('Drop a beacon (B)'),
  'Release a glowing, blinking sphere that falls freely. Watch its light redden and its blinks slow as it nears the horizon. It becomes your target.',
);
tip(
  fBeacon.add(settings, 'beaconSpeed', -0.9, 0.9, 0.01).name('Launch speed'),
  'How fast the beacon leaves the ship, as a fraction of light speed, forward (negative: backward).',
);
tip(fBeacon.add(settings, 'beaconRadius', 0.02, 1, 0.01).name('Size'), 'Beacon radius in M. Real beacons would be far too small to see at this scale.');
tip(
  fBeacon.add(settings, 'beaconTemperature', 2000, 30000, 100).name('Temperature (K)'),
  'Its colour as a blackbody. Redshift and blueshift change what you see.',
);
tip(
  fBeacon.add(settings, 'beaconPulse', 0, 20, 0.1).name('Blink period'),
  'Time between blinks by the beacon\'s own clock, in M (0: steady). Time dilation and light delay change how often you see it blink.',
);
tip(fBeacon.add({ clear: () => beacons.list.splice(0) }, 'clear').name('Remove all'), 'Delete every beacon.');
fBeacon.close();

const fCam = gui.addFolder('Camera');
tip(fCam.add(settings, 'fov', 20, 120, 1).name('Field of view'), 'Vertical field of view in degrees.');
tip(
  fCam.add(settings, 'autoExposure').name('Auto exposure'),
  'Adjusts brightness like an eye or camera. Turn it off to see how much light really changes, e.g. the darkening inside the horizon.',
);
tip(fCam.add(settings, 'exposureEV', -6, 6, 0.1).name('Exposure'), 'Brightness adjustment in photographic stops (EV).');
const skyControl = tip(
  fCam.add(settings, 'sky', { 'Procedural stars': 0, 'Lensing grid': 1 }).name('Sky'),
  'Real sky: the Milky Way and 118,000 catalogue stars, as seen from Earth. Lensing grid: lines of latitude and longitude that show how the sky is distorted.',
);
tip(fCam.add(settings, 'skyYaw', -180, 180, 1).name('Sky rotate'), 'Turn the real sky around the hole\'s spin axis, to frame different backgrounds.');
tip(fCam.add(settings, 'skyTilt', -90, 90, 1).name('Sky tilt'), 'Tilt the real sky, e.g. to angle the Milky Way across the view.');
tip(fCam.add(settings, 'bloom', 0, 1, 0.01).name('Bloom'), 'Glow around bright light (a camera-lens effect).');
tip(fCam.add(settings, 'starGain', 0, 10, 0.1).name('Star brightness'), 'Artistic: how bright stars look relative to the disk.');
tip(fCam.add(settings, 'galaxyGain', 0, 10, 0.1).name('Milky Way brightness'), 'Artistic: how bright the Milky Way glow looks relative to the disk.');
tip(
  fCam.add(settings, 'quality', ['draft', 'high', 'ultra']).name('Ray quality'),
  'How finely each light path is traced. Higher is more accurate near the hole but slower.',
);
tip(
  fCam
    .add(settings, 'renderScale', 0.25, 1, 0.05)
    .name('Render scale')
    .onChange((v: number) => setTraceScale(v)),
  'Fraction of screen resolution to ray-trace at (the most it will use, with Adaptive resolution on).',
);
tip(
  fCam.add(settings, 'adaptiveRes').name('Adaptive resolution').onChange((on: boolean) => {
    if (!on) setTraceScale(settings.renderScale);
  }),
  'When frames take too long (deep in the hole, say), trace at a lower resolution until the frame rate recovers. It never goes above Render scale, so it only ever saves work. The physics is the same either way.',
);
tip(
  fCam.add({ photo: () => photo.toggle(true) }, 'photo').name('📷 Photo mode (K)'),
  'Stop time, frame a shot and save it as a high-resolution PNG: 4K or 8K, supersampled, with framing guides, camera roll and colour looks.',
);
fCam.close();

const fMood = gui.addFolder('Ambience');
tip(
  fMood.add(settings, 'sound').name('Sound').onChange((on: boolean) => ambience.setEnabled(on)),
  'A sonification: space is silent, so the ship turns what it sees and feels into sound. The hum follows the shift of the light ahead; your heartbeat is your clock and the chime is the far-away clock; engines rumble with felt g; the hull creaks with tidal stretching; beacons ping when their blinks reach you.',
);
tip(fMood.add(settings, 'volume', 0, 1, 0.01).name('Volume').onChange((v: number) => ambience.setVolume(v)), 'Master volume.');
tip(fMood.add(settings, 'captions').name('Captions'), 'Short notes as you cross real landmarks: the photon region, the ISCO, the ergosphere, the horizon.');
tip(
  fMood.add(settings, 'cinematic').name('Cinematic mode (C)').onChange(() => applyCinematic()),
  'Hide all the controls and instruments, letterbox the view, and add film grain and a vignette. Press C (or Esc) to come back.',
);
tip(fMood.add(settings, 'drift').name('Slow camera drift'), 'In cinematic mode, slowly pan the view when you leave the controls alone.');
tip(fMood.add(settings, 'grain', 0, 1, 0.01).name('Film grain'), 'Artistic: photographic grain.');
tip(fMood.add(settings, 'vignette', 0, 1, 0.01).name('Vignette'), 'Artistic: darken the corners, like a lens.');
fMood.close();

const photo = new PhotoMode({
  renderer,
  canvas,
  settings,
  mainGui: gui,
  frameParams: (quality = 'ultra') => frameParams(quality),
  simulate: (dt) => simulate(dt, true, false),
  warps: WARPS,
  changed: refresh,
  setCinematic: (on) => {
    settings.cinematic = on;
    applyCinematic();
  },
});

// ---------------------------------------------------------------- input

const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  keys.add(e.code);
  if (e.code === 'KeyH') {
    settings.hover = !settings.hover;
    hoverAnchor = null;
  }
  if (e.code === 'KeyP') settings.paused = !settings.paused;
  if (e.code === 'KeyB') dropBeacon();
  if (e.code === 'KeyT') cycleTarget();
  if (e.code === 'KeyV') settings.rearView = !settings.rearView;
  if (e.code === 'Slash') document.getElementById('help')!.classList.toggle('collapsed');
  if (e.code === 'KeyK' || (e.code === 'Escape' && photo.active)) {
    photo.toggle();
    e.preventDefault();
    return;
  }
  if (photo.active && (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyG')) {
    void (e.code === 'KeyG' ? photo.record() : photo.capture());
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyC' || (e.code === 'Escape' && settings.cinematic)) {
    settings.cinematic = !settings.cinematic;
    applyCinematic();
  }
  lastInput = performance.now();
  const sas = SAS_MODES.find((m) => e.code === `Digit${m.key}`);
  if (sas) setAttitude(sas.mode);
  if (e.code === 'Comma') settings.logWarp = Math.max(-6, settings.logWarp - 1);
  if (e.code === 'Period') settings.logWarp = Math.min(7, settings.logWarp + 1);
  refresh();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  lastInput = performance.now();
  const k = ((settings.fov / 60) * 0.0035) as number;
  ship.rotate(1, e.movementX * k); // yaw
  ship.rotate(0, e.movementY * k); // pitch
  pilotTurned();
});

window.addEventListener('resize', () => {
  renderer.resize();
  redraw();
});

// ---------------------------------------------------------------- simulation loop

const hud = document.getElementById('hud')!;
const navHud = new NavHud(document.getElementById('nav') as HTMLCanvasElement);
let last = performance.now();
let frameMs = 16;
let feltG = 0;
let hudTimer = 0;
/** Where frame time goes (ms), for the console: flight.timings. */
const timings = { render: 0, instruments: 0, meter: 0 };
/** Auto-exposure state: multiplier applied before tone-mapping, eased toward its target. */
let autoGain = 1;
let meterTimer = 0;

function frame(now: number) {
  const dtReal = Math.min((now - last) / 1000, 0.1);
  last = now;
  // While a photo develops, the canvas is the photo's.
  if (photo.busy) {
    requestAnimationFrame(frame);
    return;
  }
  frameMs = 0.9 * frameMs + 0.1 * (dtReal * 1000);

  simulate(dtReal, !settings.paused, true);

  // Trace a new picture only when there's something new to see. Once the journey has ended
  // the last frame stays (the epilogue covers it); while paused, only looking around or
  // changing a setting needs one. (Otherwise the GPU would keep tracing the same light paths,
  // and after the end the most expensive ones there are, from deep inside the hole.)
  const params = frameParams();
  const key = ended ? `ended ${renderer.generation}` : settings.paused ? viewKey() : null;
  // After a change, keep drawing a moment longer, and while auto-exposure is still
  // adjusting: its light meter only reads frames that are drawn.
  if (key !== lastViewKey) settleUntil = now + 1500;
  const fresh = key === null || key !== lastViewKey || (!ended && (now < settleUntil || exposureSettling));
  lastViewKey = key;
  const t0 = performance.now();
  if (fresh) renderer.render(params);
  if (fresh && key === null) adaptResolution();
  else adaptSince = 0; // paused or ended: start timing afresh when running again
  const t1 = performance.now();
  drawInstruments();
  timings.render = t1 - t0;
  timings.instruments = performance.now() - t1;

  // Like a camera: aim to put the brightest few percent of the frame near white.
  meterTimer -= dtReal;
  if (fresh && meterTimer <= 0) {
    meterTimer = 0.25;
    const tm = performance.now();
    const bright = renderer.meterLuminance();
    timings.meter = performance.now() - tm;
    if (bright > 0 && Number.isFinite(bright)) sceneBrightness = Math.min(1, Math.max(0, 0.55 + 0.25 * Math.log10(bright)));
    exposureSettling = false;
    if (settings.autoExposure && bright > 0 && Number.isFinite(bright)) {
      const target = Math.min(Math.max(0.9 / bright, 0.05), 50);
      exposureSettling = Math.abs(target / autoGain - 1) > 0.03;
      autoGain *= (target / autoGain) ** 0.35;
    }
  }

  hudTimer -= dtReal;
  if (hudTimer <= 0) {
    hudTimer = 0.12;
    updateHud();
  }
  updateAmbience(dtReal);
  requestAnimationFrame(frame);
}

/** Trace at this fraction of screen resolution. */
function setTraceScale(v: number) {
  if (Math.abs(renderer.renderScale - v) < 1e-3) return;
  renderer.renderScale = v;
  renderer.resize();
}

/**
 * Adaptive resolution: once a second, if frames have averaged slower than 40 per second,
 * trace at 85% of the resolution; if faster than 55, step back up toward Render scale.
 */
let adaptSince = 0;
let adaptFrames = 0;
function adaptResolution() {
  if (!settings.adaptiveRes) return;
  const now = performance.now();
  if (!adaptSince) adaptSince = now;
  adaptFrames++;
  if (now - adaptSince < 1000) return;
  const mean = (now - adaptSince) / 1000 / adaptFrames; // real seconds per frame
  adaptSince = now;
  adaptFrames = 0;
  if (mean > 1 / 40) setTraceScale(Math.max(0.3, Math.min(settings.renderScale, renderer.renderScale * 0.85)));
  else if (mean < 1 / 55 && renderer.renderScale < settings.renderScale) setTraceScale(Math.min(settings.renderScale, renderer.renderScale * 1.1));
}

/** The last frame's view, while nothing should change it (see frame()); null when running. */
let lastViewKey: string | null = null;
/** Keep drawing until this time (ms), and while auto-exposure is still adjusting. */
let settleUntil = 0;
let exposureSettling = false;

/**
 * Everything a paused view depends on: where the ship is and how it's turned, every
 * setting, the exposure and the window. If none of it changes, neither does the picture.
 */
function viewKey() {
  // Rounded, so the last-digit jitter of re-applying the same attitude every frame (Hold) or
  // an exposure that has all but settled doesn't count as a change.
  const round = (_: string, v: unknown) => (typeof v === 'number' ? Number(v.toPrecision(7)) : v);
  return JSON.stringify([ship.x, ship.u, ship.e, settings, autoGain.toPrecision(2), photo.roll(), photo.pan(), renderer.generation, beacons.list.length], round);
}

/** Make the next frame trace a new picture (after something outside viewKey changes). */
function redraw() {
  lastViewKey = null;
}

/**
 * Advance the simulation by dtReal seconds of real time (at the current time warp) if
 * `run`, steering by the keyboard if `piloted`. The attitude modes act either way.
 */
function simulate(dtReal: number, run: boolean, piloted: boolean) {
  // Turning: Q/E roll, arrow keys pitch/yaw.
  const held = (k: string) => piloted && keys.has(k);
  const turn = dtReal * 1.2;
  if (held('KeyQ')) ship.rotate(2, -turn);
  if (held('KeyE')) ship.rotate(2, turn);
  if (held('ArrowLeft')) ship.rotate(1, -turn);
  if (held('ArrowRight')) ship.rotate(1, turn);
  if (held('ArrowUp')) ship.rotate(0, turn);
  if (held('ArrowDown')) ship.rotate(0, -turn);
  if (['KeyQ', 'KeyE', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].some(held)) pilotTurned();

  // Engines: thrust is a proper acceleration in the ship's frame (right, up, forward).
  const dir: Vec3 = [
    (held('KeyD') ? 1 : 0) - (held('KeyA') ? 1 : 0),
    (held('KeyR') ? 1 : 0) - (held('KeyF') ? 1 : 0),
    (held('KeyW') ? 1 : 0) - (held('KeyS') ? 1 : 0),
  ];
  const manual = dir.some((c) => c !== 0);
  const thrust = gToGeometric(settings.thrustG * (held('ShiftLeft') || held('ShiftRight') ? 10 : 1), settings.mass);
  const pilot: Vec3 = dir.map((c) => c * thrust) as Vec3;
  // While the pilot thrusts, the autopilot only cancels gravity; when they stop, it holds
  // wherever they got to.
  if (manual) hoverAnchor = null;
  else if (settings.hover && !hoverAnchor) hoverAnchor = [ship.x[1], ship.x[2], ship.x[3]];
  let lastAcc: Vec3 = pilot;
  // Evaluated on every physics substep, so the autopilot stays stable at any time warp.
  const control = (s: Ship): Vec3 => {
    let acc = pilot;
    if (settings.hover) {
      const r = hole.radius(s.x);
      const hold = manual
        ? s.hoverThrust(hole, Infinity)
        : s.hoverThrust(hole, Math.max(4, 0.3 * r ** 1.5), hoverAnchor ?? undefined);
      if (hold) acc = acc.map((c, i) => c + hold[i]) as Vec3;
    }
    // Retro-brake: against the motion relative to the local co-rotating (ZAMO) observer,
    // down to the ISCO. Below it nothing can orbit, and gravity alone finishes the job.
    braking = false;
    if (settings.brake && !manual && hole.radius(s.x) > brakeFloor()) {
      const d = lockDirection(hole, s, 'retrograde', undefined, 'zamo');
      if (d) {
        const g = hole.metric(s.x);
        const c = s.e.map((e) => inner(g, d, e));
        const n = Math.hypot(...c);
        if (n > 0) {
          acc = acc.map((q, i) => q + (brakeA * c[i]) / n) as Vec3;
          braking = true;
        }
      }
    }
    lastAcc = acc;
    return acc;
  };

  if (run && !ship.crushed) {
    const dTau = (dtReal * 10 ** settings.logWarp) / gravitationalTime(settings.mass);
    ship.step(hole, dTau, control, 3000);
  } else {
    control(ship);
  }
  // Reaction wheels. Hold: keep the navball reading where the pilot left it. Locks: slew
  // toward a direction. Free: nothing at all; the ship's axes are carried by its gyroscopes
  // (near a spinning hole they slowly precess against the distant stars).
  const nav = settings.attitude === 'free' ? null : navState(hole, ship, settings.reference);
  if (!nav) {
    // Free gyro.
  } else if (!nav.valid && settings.attitude !== 'target') {
    // Hold and the locks steer by the navigation solution. Without one, a real autopilot
    // lets go rather than steer by garbage, and the ship flies on its gyroscopes.
    setAttitude('free');
    autopilotLetGo = true;
  } else if (settings.attitude === 'hold') {
    if (!heldBall) captureHold();
    applyHold(nav.ball);
  } else {
    const aim = lockDirection(hole, ship, settings.attitude, targetPosition(), settings.reference);
    // Slew at the reaction wheels' rate, plus however far the target itself moved since
    // last frame (measured in the ship's own non-rotating frame). So a lock catches up at a
    // steady rate and then keeps up at any time warp: however fast the target swings round on
    // screen, in the ship's own time it turns slowly (about once an orbit), which real
    // wheels track with ease.
    if (aim) {
      const now = bodyDirection(hole, ship, aim);
      const swing = now && lastAim ? Math.acos(Math.max(-1, Math.min(1, now[0] * lastAim[0] + now[1] * lastAim[1] + now[2] * lastAim[2]))) : 0;
      ship.turnToward(hole, aim, SLEW_RATE * dtReal + swing);
      lastAim = bodyDirection(hole, ship, aim);
    }
  }
  // The navigation computer keeps the gyro platform aligned while it has a reference.
  alignPlatform(hole, ship, settings.reference);
  feltG = geometricToG(Math.hypot(...lastAcc), settings.mass);
  beacons.advanceTo(ship.x[0]);
  if (wasBraking && !braking && settings.brake && !ship.crushed && hole.radius(ship.x) <= brakeFloor()) {
    showCaption({
      text: brakePolar
        ? 'Retro-brake off. Below the innermost stable polar orbit no braking is needed: gravity alone spirals you in over the poles from here.'
        : 'Retro-brake off. Below the innermost stable orbit no braking is needed: gravity alone spirals you in from here, just as it does the disk\'s gas.',
      landmark: false,
    });
  }
  wasBraking = braking;
  // A real hull has a breaking point: the tidal stretch from nose to tail.
  const tidal = tidalAcceleration(Math.max(hole.radius(ship.x), 1e-3), SHIP_LENGTH_M, gravitationalRadius(settings.mass));
  if (!ship.crushed && tidal > HULL_LIMIT_G) ship.end('tidal');
}


/** Navball, speed tape and altimeter, measured against the local hovering observer. */
function drawInstruments() {
  const a = hole.a;
  const t = targetPosition();
  const target = t ? bodyDirection(hole, ship, [0, t[0] - ship.x[1], t[1] - ship.x[2], t[2] - ship.x[3]]) : null;
  const nav = navState(hole, ship, settings.reference);
  if (navWasValid && !nav.valid && !ship.crushed) {
    showCaption({
      text:
        settings.reference === 'static'
          ? `NAV caution. Inside the ergosphere nothing can stay at rest relative to the distant stars, so the navigation computer has no stationary frame to measure against. The ball is on gyros alone.${autopilotLetGo ? ' The autopilot has let go: the ship is flying free on its gyroscopes.' : ''}`
          : `NAV caution. Inside the horizon nothing can hold still, so the navigation computer has no hold-still frame to measure against. The ball is on gyros alone.${autopilotLetGo ? ' The autopilot has let go: the ship is flying free on its gyroscopes.' : ''}`,
      landmark: false,
      keep: true,
    });
  }
  navWasValid = nav.valid;
  autopilotLetGo = false;
  const r = hole.radius(ship.x);
  const lamps = { homeLost: home === null, tidalG: tidalAcceleration(Math.max(r, 1e-3), SHIP_LENGTH_M, gravitationalRadius(settings.mass)) };
  navHud.draw(nav, {
    r: hole.radius(ship.x),
    horizon: hole.horizonRadius,
    metresPerM: gravitationalRadius(settings.mass),
    landmarks: [
      ['ergosphere', 2],
      ['photon orbit', 2 * (1 + Math.cos((2 / 3) * Math.acos(-a)))],
      ['ISCO', disk.rIn],
      ['disk edge', disk.rOut],
    ],
  }, target, lamps);
  updateSasButtons();
}

// ---------------------------------------------------------------- attitude modes (SAS)

/** Reaction-wheel slew rate, radians per real second. */
const SLEW_RATE = 1.6;

const sasBar = document.getElementById('sas')!;
SAS_MODES.forEach((m) => {
  const b = document.createElement('button');
  b.dataset.mode = m.mode;
  b.dataset.tip = `${m.label} · key ${m.key}`;
  b.innerHTML = `<span class="icon">${m.icon}</span><span class="key">${m.key}</span>`;
  b.addEventListener('click', () => setAttitude(m.mode));
  sasBar.appendChild(b);
});

function updateSasButtons() {
  for (const b of sasBar.querySelectorAll('button')) {
    const mode = b.dataset.mode as LockMode;
    b.classList.toggle('active', mode === settings.attitude);
    b.classList.toggle('unavailable', !lockAvailable(mode));
  }
}

/**
 * Whether a lock can engage: its direction must exist (no prograde at rest, no target with
 * none), and all but the target lock steer by the navigation solution, which must be valid.
 */
function lockAvailable(mode: LockMode) {
  if (mode === 'free') return true;
  if (mode !== 'target' && !navState(hole, ship, settings.reference).valid) return false;
  if (mode === 'hold') return true;
  return lockDirection(hole, ship, mode, targetPosition(), settings.reference) !== null;
}

/** Where the lock's target was last frame, along the ship's axes (to track its motion). */
let lastAim: V3 | null = null;

function setAttitude(mode: LockMode) {
  lastAim = null;
  if (mode !== 'target' && !lockAvailable(mode)) {
    refresh(); // undo a GUI selection
    return;
  }
  settings.attitude = mode;
  captureHold();
  if (mode === 'target' && settings.target < 0) cycleTarget();
  refresh();
}

/**
 * The pilot turned by hand: a lock lets go and holds wherever they're now pointing (or, with
 * no navigation solution to hold by, leaves the ship free).
 */
function pilotTurned() {
  lastAim = null;
  captureHold();
  if (settings.attitude !== 'free' && settings.attitude !== 'hold') {
    settings.attitude = heldBall ? 'hold' : 'free';
    refresh();
  }
}

function cycleTarget() {
  const n = beacons.list.length;
  settings.target = n ? (settings.target + 1) % n : -1;
}

/** Current coordinate position of the targeted beacon, if any. */
function targetPosition(): Vec3 | undefined {
  const b = beacons.list[settings.target];
  return b ? [b.x[1], b.x[2], b.x[3]] : undefined;
}

/** Everything the renderer needs to draw the view from the ship right now. */
function frameParams(quality = settings.quality): FrameParams {
  const r = hole.radius(ship.x);
  const q = QUALITY[quality];
  // Radiance is measured relative to a blackbody at the disk's peak temperature, so the HDR
  // buffer holds numbers near 1 (real radiances, ~10⁷ W·sr⁻¹·m⁻², would overflow half floats).
  const exposure = 1.4 * 2 ** settings.exposureEV * (settings.autoExposure ? autoGain : 1);
  const position: [number, number, number] = [ship.x[1], ship.x[2], ship.x[3]];
  return {
    position,
    // Looking back: the same frame turned 180° about "up" (right and forward reversed).
    frame: cameraFrame(),
    fovY: (settings.fov * Math.PI) / 180,
    spin: hole.a,
    horizon: hole.horizonRadius,
    inside: r < hole.horizonRadius,
    diskOn: settings.diskOn,
    diskIn: disk.rIn,
    diskOut: disk.rOut,
    time: ship.x[0] % 1e5,
    turbulence: settings.turbulence,
    maxSteps: q.maxSteps,
    stepScale: q.stepScale,
    diskGain: 1 / referenceLuminance,
    shifts: settings.shifts,
    skyMode: settings.sky,
    skyMatrix: skyMatrix(settings.skyYaw, settings.skyTilt),
    // Sky brightness relative to the disk is an artistic choice (see the Camera menu).
    starGain: settings.starGain * (settings.sky === 2 ? REAL_STAR_GAIN : 0.15),
    galaxyGain: settings.galaxyGain * (settings.sky === 2 ? REAL_MILKY_WAY_GAIN : 1),
    exposure,
    bloom: settings.bloom,
    grain: settings.grain,
    vignette: settings.vignette,
    grade: photo.grade(),
    bodies: beacons.frames(ship.x[0], position, {
      radius: settings.beaconRadius,
      temperature: settings.beaconTemperature,
      pulse: settings.beaconPulse,
    }),
    bodyGain: 1 / referenceLuminance,
  };
}

/**
 * The camera's frame: the ship's (u, right, up, forward), turned 180° about "up" when
 * looking back, panned about "up" and rolled about "forward" by the photo-mode camera.
 */
function cameraFrame(): FrameParams['frame'] {
  const back = settings.rearView ? -1 : 1;
  const r0 = ship.e[0].map((c) => back * c);
  const f0 = ship.e[2].map((c) => back * c);
  const pan = photo.pan();
  const cp = Math.cos(pan);
  const sp = Math.sin(pan);
  const right = r0.map((c, k) => cp * c - sp * f0[k]);
  const forward = f0.map((c, k) => cp * c + sp * r0[k]);
  const up = ship.e[1];
  const roll = photo.roll();
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  return [
    ship.u,
    right.map((c, k) => cr * c + sr * up[k]),
    up.map((c, k) => -sr * right[k] + cr * c),
    forward,
  ];
}

/** Explanations shown when hovering the HUD's labels. */
const HUD_TIPS: Record<string, string> = {
  Distance: 'Your distance from the centre, in M (the hole\'s gravitational radius, GM/c²) and in real units.',
  Horizon: 'Radius of the event horizon: once inside, every path leads inward.',
  'Speed vs stationary': 'Your speed relative to someone at rest with respect to the far-away universe at this spot, with the Lorentz factor γ. Inside the ergosphere no one can be at rest: space is dragged around too fast.',
  'Gravity to hover': 'The thrust needed to hold position here, in g.',
  'Felt acceleration': 'What an accelerometer on board reads. In free fall it is 0: you feel weightless however strong the gravity.',
  Attitude: 'What the reaction wheels are doing (keys 1–8, 0).',
  Target: 'Straight-line distance to the selected beacon (where you see it differs: light delay and lensing).',
  'Your clock': 'Time that has passed on board.',
  'Far-away clock': 'Coordinate time far from the hole. (In relativity "what time is it there now" is a convention; this is the simulation\'s.)',
  'Home signal':
    'A radio signal from far away arrives blueshifted or redshifted by this factor: that is how fast home\'s clock ticks reach you (and the chime you hear). A naive Doppler speedometer turns the shift into a speed, but it can\'t tell gravity from motion: hover low and it says you\'re racing toward home.',
  'Your time rate': 'How fast your clock runs compared with coordinate time far away: gravity and speed both slow it.',
  'Time warp': 'How much faster than real time your clock is running.',
  'Disk peak': 'The disk\'s hottest temperature, from the hole\'s mass, spin and accretion rate.',
  Frame: 'Time to draw each frame, and the resolution being traced if Adaptive resolution has lowered it to keep up.',
};

function updateHud() {
  const M = settings.mass;
  const rg = gravitationalRadius(M);
  const tg = gravitationalTime(M);
  const r = hole.radius(ship.x);
  const rel = ship.relativeToStatic(hole);
  const grav = ship.localGravity(hole);
  const row = (label: string, value: string) =>
    `<div class="row"><span class="label"${HUD_TIPS[label] ? ` data-tip="${HUD_TIPS[label]}"` : ''}>${label}</span><span>${value}</span></div>`;
  const lines = [
    `<h1>${HOLES[settings.hole]?.label ?? 'Black hole'} · spin ${settings.spin.toFixed(3)}</h1>`,
    row('Distance', `${r.toFixed(2)} M · ${formatDistance(r * rg)}`),
    row('Horizon', `${hole.horizonRadius.toFixed(3)} M · ${formatDistance(hole.horizonRadius * rg)}`),
    rel
      ? row('Speed vs stationary', `${rel.speed.toFixed(4)} c · γ ${rel.gamma.toFixed(3)}`)
      : row('Speed vs stationary', 'nothing can be stationary here'),
    grav !== null ? row('Gravity to hover', `${geometricToG(grav, M).toPrecision(3)} g`) : '',
    row('Felt acceleration', `${feltG.toPrecision(3)} g${settings.hover ? ' (autopilot)' : braking ? ' (retro-brake)' : ''}`),
    row('Attitude', SAS_MODES.find((m) => m.mode === settings.attitude)?.short ?? ''),
    targetPosition()
      ? row(
          'Target',
          `Beacon ${settings.target + 1} · ${Math.hypot(
            ...targetPosition()!.map((c, i) => c - ship.x[i + 1]),
          ).toFixed(2)} M (straight line)`,
        )
      : '',
    row('Your clock', formatDuration(ship.tau * tg)),
    row('Far-away clock', formatDuration(ship.x[0] * tg)),
    home
      ? row(
          'Home signal',
          `×${home.g.toFixed(3)} · Doppler says ${Math.abs(home.dopplerSpeed).toFixed(3)}c ${home.dopplerSpeed > 0 ? 'away' : 'toward home'}`,
        )
      : row('Home signal', 'not received'),
    row('Your time rate', `${(1 / ship.u[0]).toFixed(4)} × far-away`),
    row('Time warp', `${warpLabel(settings.logWarp)}${settings.paused ? ' · paused' : ''}`),
    row('Disk peak', `${Math.round(disk.Tmax).toLocaleString()} K at ${disk.rPeak.toFixed(1)} M`),
    row('Frame', `${frameMs.toFixed(0)} ms${renderer.renderScale < settings.renderScale - 1e-3 ? ` · traced at ${Math.round(100 * renderer.renderScale)}%` : ''}`),
  ];
  // The velocity budget: relative to someone hovering here, (dτ/dt)² + v² = 1 exactly.
  if (rel) {
    const time = 100 / (rel.gamma * rel.gamma);
    lines.push(
      `<div class="budget-label"><span>Spent on time ${time.toFixed(1)}%</span><span>on space ${(100 - time).toFixed(1)}%</span></div>`,
      `<div class="budget"><span class="time" style="width:${time}%"></span><span class="space" style="width:${100 - time}%"></span></div>`,
    );
  }
  beacons.list.forEach((b, i) => {
    const v = beacons.speedVsHover(b);
    const br = hole.radius(b.x);
    const where =
      b.fate === 'absorbed' ? 'reached the singularity' : br < hole.horizonRadius ? 'inside the horizon' : `${br.toFixed(2)} M`;
    const speed = v !== null && b.alive ? ` · ${v.toFixed(3)} c` : '';
    lines.push(row(`Beacon ${i + 1}`, `${where}${speed} · its clock ${formatDuration(b.tau * tg)}`));
  });
  if (settings.rearView) lines.push('<div class="warn">Looking back (V)</div>');
  if (ship.crushed) {
    const how = { innerHorizon: 'Reached the inner horizon', singularity: 'Reached the singularity', tidal: 'Torn apart by tides' }[
      ship.fate ?? 'singularity'
    ];
    lines.push(`<div class="warn">${how}. Restart from the Ship menu.</div>`);
  }
  else if (r < hole.horizonRadius)
    lines.push(
      '<div class="warn">Inside the event horizon: every future path leads inward. The outside universe is behind you (V to look back).</div>',
    );
  else if (!rel) lines.push('<div class="warn">Inside the ergosphere: space itself drags you around.</div>');
  hud.innerHTML = lines.join('');
}

requestAnimationFrame(frame);

// ---------------------------------------------------------------- the real sky

const REAL_STAR_GAIN = 0.35;
const REAL_MILKY_WAY_GAIN = 0.12;

/** Load the real sky in the background; switch to it once it's ready. */
loadRealSky().then((sky) => {
  if (!sky) {
    console.info('Real sky not built: run `npm run fetch-sky` in app/ to use it. Using the procedural sky.');
    return;
  }
  renderer.setRealSky(sky);
  redraw();
  skyControl.options({ 'Real sky (as seen from Earth)': 2, 'Procedural stars': 0, 'Lensing grid': 1 }).name('Sky');
  settings.sky = 2;
  refresh();
  document.getElementById('credits')!.textContent = `Sky: ${sky.credits.join(' ')}`;
});

// ---------------------------------------------------------------- ambience

const ambience = new Ambience();
let sceneBrightness = 0.5;
let view: ViewSample = { kind: 'sky', g: 1 };
let home: HomeSignal | null = null;
/** Whether the navigation computer had a valid solution last frame (for the caution). */
let navWasValid = true;
let ambienceTimer = 0;
let beaconTimer = 0;
let lastInput = performance.now();

// Audio may only start after a user gesture.
for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, () => ambience.start());

function updateAmbience(dtReal: number) {
  const M = settings.mass;
  const rg = gravitationalRadius(M);
  const r = hole.radius(ship.x);
  const tidalG = tidalAcceleration(Math.max(r, 1e-3), SHIP_LENGTH_M, rg);

  // What's ahead (or behind, looking back): a few times a second.
  ambienceTimer -= dtReal;
  if (ambienceTimer <= 0 && !ship.crushed) {
    ambienceTimer = 0.25;
    view = sampleView(hole, ship, disk.rIn, settings.diskOn ? disk.rOut : 0, settings.rearView);
    // Home's signal comes from straight up: find where "up" appears in the ship's view (the
    // river frame exists everywhere) and trace that ray out to the far sky.
    home = homeSignal(hole, ship, worldToShip(navState(hole, ship, 'river'), [0, 0, 1]));
  }
  // The story: checked every frame, since at high warp the last few M of a fall pass in a blink.
  const a = hole.a;
  const captions = story.update({
    r,
    inErgosphere: hole.metric(ship.x)[0][0] > 0,
    horizon: hole.horizonRadius,
    innerHorizon: a > 0 ? 2 - hole.horizonRadius : 0,
    isco: disk.rIn,
    photonOuter: 2 * (1 + Math.cos((2 / 3) * Math.acos(a))),
    speed: (() => {
      const n = navState(hole, ship, settings.reference);
      return n.valid ? n.speed : 0;
    })(),
    timeAhead: (ship.x[0] - ship.tau) * gravitationalTime(M),
    tidalG,
  });
  if (settings.captions && captions.length) {
    // Several landmarks in one step: only the deepest describes where you are now.
    const landmarks = captions.filter((c) => c.landmark);
    if (landmarks.length) showCaption(landmarks[landmarks.length - 1]);
    captions.filter((c) => !c.landmark).forEach(showCaption);
  }

  // Beacons: find each in the view with real light rays; ping on each blink that arrives.
  beaconTimer -= dtReal;
  if (beaconTimer <= 0 && settings.beaconPulse > 0) {
    beaconTimer = 0.12;
    for (const b of beacons.list) {
      const st = sightings.get(b.id) ?? { dir: null, blink: -1 };
      const seen = sightBeacon(hole, ship, b, beacons.rayBody(b, ship.x[0], settings.beaconRadius).at, settings.beaconRadius, st.dir);
      st.dir = seen?.dir ?? null;
      if (seen) {
        const blink = Math.floor(seen.tau / settings.beaconPulse);
        if (st.blink >= 0 && blink > st.blink) {
          const d = Math.hypot(b.x[1] - ship.x[1], b.x[2] - ship.x[2], b.x[3] - ship.x[3]);
          ambience.ping(seen.g, Math.min(1, seen.g * seen.g) * Math.min(1, 6 / Math.max(d, 1)));
        }
        st.blink = blink;
      }
      sightings.set(b.id, st);
    }
  }

  ambience.update(
    {
      running: !settings.paused && !ship.crushed,
      viewG: view.g,
      viewKind: view.kind,
      brightness: sceneBrightness,
      feltG,
      tidalG,
      // Home's clock ticks reach you at the rate its signal's frequency is shifted.
      timeRate: home ? home.g : 0,
    },
    dtReal,
  );

  // Cinematic drift: a slow pan when the pilot leaves the controls alone.
  if (settings.cinematic && settings.drift && performance.now() - lastInput > 3000 && settings.attitude === 'hold') {
    ship.rotate(1, 0.035 * dtReal);
    captureHold();
  }

  if (ship.crushed && !ended) {
    ended = true;
    const fate: Fate = ship.fate ?? 'singularity';
    // At the inner horizon, an illustrative white-out (see the epilogue) before the words.
    if (fate === 'innerHorizon') {
      document.getElementById('flash')!.classList.add('show');
      window.setTimeout(() => showEpilogue(fate), 1800);
    } else showEpilogue(fate);
  }
}

// Captions: one at a time, and only while their moment is happening. A landmark (where you
// are now) takes over at once; milestones (speed, time, tides) wait their turn, and only
// the newest one waits.
function showCaption(c: Caption) {
  // Cautions are never dropped, only delayed.
  const kept = captionQueue.filter((q) => q.keep);
  if (c.landmark) {
    // A caution that's showing, or a milestone that only just appeared (caused by the same
    // crossing, say), comes back after the landmark.
    const now = captionNow && !captionNow.caption.landmark ? captionNow : null;
    const interrupted = now && (now.caption.keep || performance.now() - now.since < 1500) ? now.caption : null;
    captionQueue.length = 0;
    captionQueue.push(c);
    if (interrupted) captionQueue.push(interrupted);
    captionQueue.push(...kept.filter((q) => q !== interrupted));
    nextCaption();
    return;
  }
  // Otherwise cautions wait in order, and of the milestones only the newest one waits.
  const milestones = captionQueue.filter((q) => !q.keep);
  const newest = c.keep ? milestones.slice(-1) : [c];
  captionQueue.length = 0;
  captionQueue.push(...kept, ...(c.keep ? [c] : []), ...newest);
  if (!captionNow) nextCaption();
}
function nextCaption() {
  captionTimers.forEach(clearTimeout);
  captionTimers = [];
  const c = captionQueue.shift();
  if (!c) {
    captionNow = null;
    return;
  }
  const hold = captionQueue.length ? 3800 : 6000;
  captionEl.textContent = c.text;
  captionEl.classList.add('show');
  captionNow = { caption: c, since: performance.now() };
  captionTimers = [
    window.setTimeout(() => captionEl.classList.remove('show'), hold),
    window.setTimeout(nextCaption, hold + 900),
  ];
}
function clearCaptions() {
  captionQueue.length = 0;
  captionTimers.forEach(clearTimeout);
  captionTimers = [];
  captionNow = null;
  captionEl.classList.remove('show');
}


function showEpilogue(fate: Fate) {
  if (!ended) return; // restarted meanwhile
  clearCaptions();
  const tg = gravitationalTime(settings.mass);
  const [title, ...lines] = epilogue(fate, formatDuration(ship.tau * tg), formatDuration(ship.x[0] * tg));
  const el = document.getElementById('epilogue')!;
  el.querySelector('h2')!.textContent = title;
  el.querySelector('.lines')!.innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
  el.classList.add('show');
}
function hideEpilogue() {
  ended = false;
  document.getElementById('flash')!.classList.remove('show');
  clearCaptions();
  document.getElementById('epilogue')?.classList.remove('show');
}
document.getElementById('epilogue-restart')!.addEventListener('click', () => {
  resetShip();
  refresh();
});

// Cinematic mode: no UI, letterboxed, with grain and a vignette unless the pilot set their own.
let savedLook: { grain: number; vignette: number } | null = null;
function applyCinematic() {
  document.body.classList.toggle('cinematic', settings.cinematic);
  if (settings.cinematic) {
    gui.hide();
    if (settings.grain === 0 && settings.vignette === 0) {
      savedLook = { grain: 0, vignette: 0 };
      settings.grain = 0.35;
      settings.vignette = 0.55;
    }
    lastInput = performance.now();
  } else {
    gui.show();
    if (savedLook) Object.assign(settings, savedLook);
    savedLook = null;
  }
  refresh();
}

// Handy for poking at things from the console (and for automated screenshots).
Object.assign(window, {
  flight: {
    settings,
    starts: STARTS,
    get ship() {
      return ship;
    },
    get disk() {
      return disk;
    },
    get hole() {
      return hole;
    },
    get beacons() {
      return beacons;
    },
    ambience: () => ambience,
    story: () => story,
    photo,
    /** Diagnostic: the auto-exposure state. */
    get exposure() {
      return { autoGain, settling: exposureSettling, settleUntil, now: performance.now() };
    },
    /** Diagnostic: per-pixel ray integration steps for the current view. */
    countSteps: (quality?: 'draft' | 'high' | 'ultra') => renderer.countSteps(frameParams(quality)),
    timings,
    setRenderScale(v: number) {
      settings.renderScale = v;
      renderer.renderScale = v;
      renderer.resize();
    },
    rebuildHole,
    resetShip,
    refresh,
  },
});
