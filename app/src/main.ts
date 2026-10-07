import GUI from 'lil-gui';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { TimeEmbedding } from './physics/embedding';
import { spatialRadius } from './physics/spacetime';
import { type Vec3, World } from './physics/world';
import { DEFAULT_VIEW, SCENARIOS, type Scenario, type ScenarioView } from './scenarios';
import { type AxisSet, Projection } from './view/projection';
import { SpacetimeView } from './view/spacetimeView';

// ---------- rendering setup ----------

const container = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.inset = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
container.appendChild(labelRenderer.domElement);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------- state ----------

const view = new SpacetimeView();
const projection = new Projection();
const settings: ScenarioView & { scenario: string; running: boolean } = {
  ...DEFAULT_VIEW,
  scenario: 'orbits',
  running: true,
};
const addBody = { kind: 'particle' as 'particle' | 'photon', x: 12, y: 0, z: 0, vx: 0, vy: 0.3, vz: 0 };

let scenario: Scenario = SCENARIOS[settings.scenario];
let world = new World(scenario.spacetime());

function loadScenario(id: string) {
  scenario = SCENARIOS[id];
  settings.scenario = id;
  world = new World(scenario.spacetime());
  scenario.setup(world);
  Object.assign(settings, DEFAULT_VIEW, scenario.view);
  syncIntegrator();
  resetCamera(true);
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  document.getElementById('hud-title')!.textContent = scenario.label;
  document.getElementById('hud-desc')!.textContent = scenario.description;
}

/** Recording resolution follows the visible window, so worldlines stay smooth at any zoom. */
function syncIntegrator() {
  world.config.recordInterval = Math.max(0.02, settings.window / 600);
  world.config.maxStep = Math.min(1, settings.window / 300);
  world.retain = Math.max(50, settings.window * 1.5);
}

/** Rebuild the time-warp surface when the spacetime or its shape settings change. */
let embeddingKey = '';
function syncEmbedding() {
  const chart = world.spacetime.chart;
  const key = [world.spacetime.id, settings.embedInner, settings.extent, settings.embedFlare].join('|');
  if (key === embeddingKey && projection.embedding?.chart === chart) return;
  embeddingKey = key;
  const rh = world.spacetime.horizonRadius ?? 0;
  try {
    projection.embedding = chart
      ? new TimeEmbedding(chart, Math.max(settings.embedInner, rh * 1.05), settings.extent, settings.embedFlare)
      : null;
  } catch (e) {
    projection.embedding = null;
    flash((e as Error).message);
  }
}

function resetCamera(useScenarioCamera = false) {
  const E = settings.extent;
  const scenarioAxes = scenario.view.axes ?? DEFAULT_VIEW.axes;
  syncEmbedding();
  const emb = projection.embedding;
  if (useScenarioCamera && scenario.camera && settings.axes === scenarioAxes) {
    camera.position.set(...scenario.camera.position);
    controls.target.set(...scenario.camera.target);
  } else if (settings.axes === 'embed' && emb) {
    const size = Math.max(emb.maxRadius, -emb.bottom);
    camera.position.set(size * 1.35, size * 0.55, size * 1.35);
    controls.target.set(0, emb.bottom * 0.5, 0);
  } else if (settings.axes === 'xyz') {
    camera.position.set(0, E * 1.7, E * 1.5);
    controls.target.set(0, 0, 0);
  } else {
    const h = settings.window * settings.timeScale;
    camera.position.set(E * 1.5, h * 0.25 + E * 0.4, E * 2.1);
    controls.target.set(0, -h * 0.35, 0);
  }
  controls.update();
}

// ---------- GUI ----------

const gui = new GUI({ title: 'Spacetime sandbox' });

const fScenario = gui.addFolder('Scenario');
fScenario
  .add(settings, 'scenario', Object.fromEntries(Object.entries(SCENARIOS).map(([id, s]) => [s.label, id])))
  .name('Load')
  .onChange(loadScenario);
fScenario.add({ reset: () => loadScenario(settings.scenario) }, 'reset').name('Restart scenario');

const fTime = gui.addFolder('Time');
fTime.add(settings, 'running').name('Running (Space)');
fTime.add(settings, 'speed', 0, 100, 0.5).name('Speed (ct per second)');

const fView = gui.addFolder('View');
fView
  .add(settings, 'axes', {
    '(ct, x, y)': 'txy',
    '(ct, x, z)': 'txz',
    '(ct, y, z)': 'tyz',
    '(x, y, z)': 'xyz',
    'Time-warp surface (t, r)': 'embed',
  } as Record<string, AxisSet>)
  .name('Displayed axes')
  .onChange(() => resetCamera());
fView.add(settings, 'slice', -30, 30, 0.1).name('Hidden coord. of field plane');
fView
  .add(settings, 'window', 5, 1000, 1)
  .name('History shown (ct)')
  .onChange(syncIntegrator);
fView.add(settings, 'timeScale', 0.05, 2, 0.01).name('ct axis scale');
fView.add(settings, 'boost', -0.95, 0.95, 0.01).name('Observer boost (β)');
fView.add(settings, 'extent', 4, 60, 1).name('Field extent');
fView.add(settings, 'embedInner', 0.5, 20, 0.1).name('Surface inner r');
fView.add(settings, 'embedFlare', 0.1, 3, 0.05).name('Surface flare');
fView.add({ reset: () => resetCamera(true) }, 'reset').name('Reset camera');

const fLayers = gui.addFolder('Layers');
fLayers.add(settings, 'worldlines').name('Worldlines / trails');
fLayers.add(settings, 'properTimeTicks').name('Proper-time ticks');
fLayers.add(settings, 'tickInterval', 0.5, 50, 0.5).name('Tick every Δτ');
fLayers.add(settings, 'lightCones').name('Light cones');
fLayers.add(settings, 'coneSpacing', 1, 15, 0.5).name('Cone spacing');
fLayers.add(settings, 'clocks').name('Static clocks');
fLayers.add(settings, 'clockSpacing', 1, 10, 0.5).name('Clock spacing');
fLayers.add(settings, 'fieldGrid').name('Coordinate grid');
fLayers.add(settings, 'horizon').name('Horizon');
fLayers.add(settings, 'dustSnapshots', 1, 12, 1).name('Dust grid snapshots');
fLayers.close();

const fAdd = gui.addFolder('Add body');
fAdd.add(addBody, 'kind', ['particle', 'photon']).name('Kind');
fAdd.add(addBody, 'x', -60, 60, 0.5);
fAdd.add(addBody, 'y', -60, 60, 0.5);
fAdd.add(addBody, 'z', -60, 60, 0.5);
fAdd.add(addBody, 'vx', -1, 1, 0.01).name('vx (or dir x)');
fAdd.add(addBody, 'vy', -1, 1, 0.01).name('vy (or dir y)');
fAdd.add(addBody, 'vz', -1, 1, 0.01).name('vz (or dir z)');
fAdd.add({ add: () => spawn([addBody.x, addBody.y, addBody.z]) }, 'add').name('Add at position');
fAdd
  .add(
    {
      dust: () => {
        const p: Vec3 = [addBody.x, addBody.y, addBody.z];
        tryOrReport(() => world.addDustGrid(p, ...projection.fieldAxes as [1 | 2 | 3, 1 | 2 | 3], 5, 5, 1.5));
      },
    },
    'dust',
  )
  .name('Drop 5×5 dust grid at position');
fAdd.add({ clear: () => world.clear() }, 'clear').name('Remove all bodies');
fAdd.close();

function spawn(pos: Vec3) {
  const v: Vec3 = [addBody.vx, addBody.vy, addBody.vz];
  tryOrReport(() => (addBody.kind === 'photon' ? world.addPhoton(pos, v) : world.addParticle(pos, v)));
}

function tryOrReport(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    flash((e as Error).message);
  }
}

let messageTimer = 0;
function flash(text: string) {
  const el = document.getElementById('message')!;
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => (el.style.opacity = '0'), 3000);
}

// ---------- input ----------

const raycaster = new THREE.Raycaster();
renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (!ev.shiftKey || ev.button !== 0) return;
  if (projection.isEmbed) {
    flash('Switch to another view to place bodies by clicking.');
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -projection.fieldPlaneY);
  const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  if (!hit) return;
  if (projection.showsTime && projection.boost !== 0) {
    flash('Set the boost to 0 to place bodies by clicking.');
    return;
  }
  const e = projection.fieldEvent(hit.x, -hit.z);
  spawn([e[1], e[2], e[3]]);
});

window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space' && !(ev.target instanceof HTMLInputElement)) {
    settings.running = !settings.running;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    ev.preventDefault();
  }
});

// ---------- main loop ----------

const stats = document.getElementById('hud-stats')!;
let lastFrame = performance.now();
let lastHud = 0;

function frame(now: number) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  if (settings.running) world.advance(dt * settings.speed);

  Object.assign(projection, {
    axes: settings.axes,
    now: world.time,
    slice: settings.slice,
    timeScale: settings.timeScale,
    boost: settings.boost,
  });
  syncEmbedding();
  view.draw(world, projection, settings);
  controls.update();
  renderer.render(view.scene, camera);
  labelRenderer.render(view.scene, camera);

  if (now - lastHud > 150) {
    lastHud = now;
    const active = world.bodies.filter((b) => b.alive).length;
    const absorbed = world.bodies.filter((b) => b.fate === 'absorbed').length;
    const hidden = projection.showsTime ? projection.axisName('hidden') : 'z';
    const emb = projection.embedding;
    stats.textContent =
      `ct = ${world.time.toFixed(1)} ${scenario.units} · ${active} active` +
      (absorbed ? ` · ${absorbed} absorbed` : '') +
      (projection.isEmbed
        ? emb
          ? ` · time wraps every ${emb.wrapTime.toFixed(0)} · exact for radial motion`
          : ''
        : ` · fields sampled at ${hidden} = ${settings.slice.toFixed(1)}`) +
      (world.spacetime.horizonRadius ? ` · horizon r = ${world.spacetime.horizonRadius}` : '');
  }
  requestAnimationFrame(frame);
}

loadScenario(settings.scenario);
requestAnimationFrame(frame);

// Handy for poking at the simulation from the browser console.
Object.assign(window, { sandbox: { get world() { return world; }, projection, spatialRadius } });
