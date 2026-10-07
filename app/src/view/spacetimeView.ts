import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { type Body, EVENT_STRIDE } from '../physics/body';
import type { TimeEmbedding } from '../physics/embedding';
import type { Vec4 } from '../physics/linalg';
import { coneSection } from '../physics/lightcone';
import { staticClockRate } from '../physics/spacetime';
import type { World } from '../physics/world';
import { LineBuffer, PointBuffer } from './buffers';
import type { Projection } from './projection';

export interface LayerSettings {
  /** Coordinate time of history shown (worldline length / trail length). */
  window: number;
  /** Half-width of the field plane covered by grids, cones and clocks. */
  extent: number;
  worldlines: boolean;
  /** Proper time between tick marks on worldlines and static clocks. */
  tickInterval: number;
  properTimeTicks: boolean;
  lightCones: boolean;
  coneSpacing: number;
  clocks: boolean;
  clockSpacing: number;
  fieldGrid: boolean;
  horizon: boolean;
  /** Past copies of dust-grid connections drawn in spacetime views. */
  dustSnapshots: number;
}

const COLORS = {
  cone: new THREE.Color(0xffb347),
  coneTrapped: new THREE.Color(0xff4d4d),
  grid: new THREE.Color(0x3a4a66),
  axis: new THREE.Color(0x8a97b0),
  horizon: new THREE.Color(0xff4d4d),
  clockFast: new THREE.Color(0xffffff),
  clockSlow: new THREE.Color(0x2f5cff),
  surfaceLine: new THREE.Color(0x5b7bb0),
  now: new THREE.Color(0xffffff),
};

const CIRCLE_SEGMENTS = 32;

/** Owns the Three.js scene and redraws every layer from the world each frame. */
export class SpacetimeView {
  readonly scene = new THREE.Scene();
  private lines = new LineBuffer();
  private faint = new LineBuffer(0.4);
  private axes = new LineBuffer(0.6);
  private ticks = new PointBuffer(4);
  private markers = new PointBuffer(10);
  private clockDots = new PointBuffer(6);
  private horizonMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000 }),
  );
  private labels = {
    h1: makeLabel(),
    h2: makeLabel(),
    v: makeLabel(),
  };
  private surface = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshLambertMaterial({
      color: 0x2a4a7a,
      emissive: 0x0a1424,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  private surfaceFor: TimeEmbedding | null = null;
  private tmpColor = new THREE.Color();
  private sample = [0, 0, 0, 0, 0];
  private sampleB = [0, 0, 0, 0, 0];

  constructor() {
    this.scene.background = new THREE.Color(0x07090e);
    for (const buf of [this.faint, this.axes, this.lines, this.ticks, this.clockDots, this.markers]) {
      this.scene.add(buf.object);
    }
    this.scene.add(this.horizonMesh, this.surface, this.labels.h1, this.labels.h2, this.labels.v);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(1, 2, 1.5);
    this.scene.add(sun, new THREE.AmbientLight(0xffffff, 0.6));
  }

  draw(world: World, p: Projection, settings: LayerSettings) {
    for (const buf of [this.lines, this.faint, this.axes, this.ticks, this.markers, this.clockDots]) buf.begin();
    const s = { ...settings, window: p.visibleWindow(settings.window) };

    if (p.isEmbed) {
      this.drawEmbedding(p, s, world.spacetime.horizonRadius !== null);
    } else {
      this.drawAxes(p, s);
      if (s.fieldGrid) this.drawFieldGrid(p, s);
      if (s.horizon) this.drawHorizon(world, p, s);
      if (s.lightCones) this.drawLightCones(world, p, s);
      if (s.clocks) this.drawClocks(world, p, s);
    }
    this.surface.visible = p.isEmbed && p.embedding !== null;
    this.drawDustGrids(world, p, s);
    for (const b of world.bodies) this.drawBody(b, p, s);

    for (const buf of [this.lines, this.faint, this.axes, this.ticks, this.markers, this.clockDots]) buf.end();

    const rh = world.spacetime.horizonRadius;
    this.horizonMesh.visible = s.horizon && rh !== null && !p.showsTime;
    if (rh !== null) {
      this.horizonMesh.scale.setScalar(rh * 0.98);
      this.horizonMesh.position.set(0, 0, 0);
    }
  }

  /** Worldline (fading with age), proper-time ticks, and a marker at "now". */
  private drawBody(b: Body, p: Projection, s: LayerSettings) {
    const color = this.tmpColor.set(b.color);
    const h = b.history;
    const t0 = p.now - s.window;
    const n = b.eventCount;
    let start = 0;
    while (start < n - 1 && h[(start + 1) * EVENT_STRIDE] < t0) start++;

    const fade = (t: number) => 0.2 + 0.8 * Math.max(0, Math.min(1, (t - t0) / s.window));
    let prev = -1;
    for (let k = start; k <= n; k++) {
      // k === n stands for the body's live state, which can be ahead of the last record.
      const o = k * EVENT_STRIDE;
      const ev = k < n ? h.slice(o, o + EVENT_STRIDE) : b.alive ? [...b.x, b.tau] : null;
      if (!ev) break;
      if (prev >= 0) {
        const pv = this.sampleB;
        if (s.worldlines) this.lines.segment(p, pv, ev, color, fade(pv[0]), fade(ev[0]));
        if (s.properTimeTicks && b.kind === 'massive') {
          const dTau = s.tickInterval;
          for (let m = Math.floor(pv[4] / dTau) + 1; m * dTau <= ev[4]; m++) {
            const f = (m * dTau - pv[4]) / (ev[4] - pv[4]);
            const lerp = (i: number) => pv[i] + f * (ev[i] - pv[i]);
            this.ticks.event(p, lerp(0), lerp(1), lerp(2), lerp(3), color);
          }
        }
      }
      for (let i = 0; i < EVENT_STRIDE; i++) this.sampleB[i] = ev[i];
      prev = k;
    }

    if (b.alive) this.markers.event(p, b.x[0], b.x[1], b.x[2], b.x[3], color);
  }

  /**
   * Neighbouring dust particles joined by lines: the "grid" that actually deforms, since
   * every node follows its own geodesic. Converging lines are gravity; stretching along
   * one direction while squeezing in others is tidal curvature.
   */
  private drawDustGrids(world: World, p: Projection, s: LayerSettings) {
    const snapshots = p.showsTime ? Math.max(1, s.dustSnapshots) : 1;
    for (const grid of world.grids) {
      const color = this.tmpColor.set(grid.bodies[0]?.color ?? 0xffffff);
      for (let k = 0; k < snapshots; k++) {
        const t = p.now - (k * s.window) / snapshots;
        const brightness = 1 - (0.7 * k) / snapshots;
        for (let j = 0; j < grid.rows; j++) {
          for (let i = 0; i < grid.cols; i++) {
            const a = grid.bodies[j * grid.cols + i];
            if (i + 1 < grid.cols) this.joinAt(a, grid.bodies[j * grid.cols + i + 1], t, p, color, brightness);
            if (j + 1 < grid.rows) this.joinAt(a, grid.bodies[(j + 1) * grid.cols + i], t, p, color, brightness);
          }
        }
      }
    }
  }

  private joinAt(a: Body, b: Body, t: number, p: Projection, color: THREE.Color, brightness: number) {
    if (!positionAt(a, t, this.sample) || !positionAt(b, t, this.sampleB)) return;
    this.lines.segment(p, this.sample, this.sampleB, color, brightness);
  }

  /**
   * Future light cones sampled on the field plane. In spacetime views these are true cones
   * (apex at now, opening upward); in the space view, the ellipsoid light from that point
   * reaches a short time later — three great ellipses of it.
   */
  private drawLightCones(world: World, p: Projection, s: LayerSettings) {
    const st = world.spacetime;
    const axes = p.showsTime ? p.fieldAxes : [1, 2, 3];
    const size = coneSize(s);
    for (const [a, b] of lattice(s.extent, s.coneSpacing)) {
      const apex = p.fieldEvent(a, b);
      if (st.isSingular(apex)) continue;
      const g = st.metric(apex);
      const sec = coneSection(g, axes);
      if (!sec) continue;
      const color = g[0][0] >= 0 ? COLORS.coneTrapped : COLORS.cone;
      const at = (w: number[]): Vec4 => {
        const e: Vec4 = [apex[0] + size, apex[1], apex[2], apex[3]];
        axes.forEach((ax, i) => {
          let si = sec.centre[i];
          for (let j = 0; j < w.length; j++) si += sec.basis[i][j] * w[j];
          e[ax] += size * si;
        });
        return e;
      };

      const rings: [number, number][] = p.showsTime ? [[0, 1]] : [[0, 1], [0, 2], [1, 2]];
      for (const [i, j] of rings) {
        let last: Vec4 | null = null;
        for (let k = 0; k <= CIRCLE_SEGMENTS; k++) {
          const th = (2 * Math.PI * k) / CIRCLE_SEGMENTS;
          const w = [0, 0, 0].slice(0, axes.length);
          w[i] = Math.cos(th);
          w[j] = Math.sin(th);
          const e = at(w);
          if (last) this.segment(this.faint, p, last, e, color);
          if (p.showsTime && k % (CIRCLE_SEGMENTS / 8) === 0 && k < CIRCLE_SEGMENTS) {
            this.segment(this.faint, p, apex, e, color);
          }
          last = e;
        }
      }
    }
  }

  /**
   * Clocks held at fixed positions. They tick every `tickInterval` of their own proper time,
   * which is √(−g_tt) slower than coordinate time: deeper in the well, slower (and bluer).
   * Spacetime views show their vertical worldlines with ticks; the space view blinks them.
   */
  private drawClocks(world: World, p: Projection, s: LayerSettings) {
    const st = world.spacetime;
    const dTau = s.tickInterval;
    for (const [a, b] of lattice(s.extent, s.clockSpacing)) {
      const ev = p.fieldEvent(a, b);
      const rate = staticClockRate(st, ev);
      if (rate === null) continue;
      const color = this.tmpColor.copy(COLORS.clockSlow).lerp(COLORS.clockFast, rate ** 6);
      if (p.showsTime) {
        const t0 = p.now - s.window;
        this.faint.segment(p, [t0, ev[1], ev[2], ev[3]], [p.now, ev[1], ev[2], ev[3]], color, 0.5);
        for (let m = Math.ceil((t0 * rate) / dTau); m <= Math.floor((p.now * rate) / dTau); m++) {
          this.ticks.event(p, (m * dTau) / rate, ev[1], ev[2], ev[3], color);
        }
      } else {
        const phase = ((p.now * rate) / dTau) % 1;
        this.clockDots.event(p, ev[0], ev[1], ev[2], ev[3], color, 0.25 + 0.75 * (1 - phase) ** 3);
      }
    }
  }

  /** A flat coordinate grid on the field plane, as a reference against which curvature shows. */
  private drawFieldGrid(p: Projection, s: LayerSettings) {
    const E = s.extent;
    const step = niceStep(E / 6);
    for (let c = -Math.floor(E / step) * step; c <= E + 1e-9; c += step) {
      this.segment(this.faint, p, p.fieldEvent(c, -E), p.fieldEvent(c, E), COLORS.grid);
      this.segment(this.faint, p, p.fieldEvent(-E, c), p.fieldEvent(E, c), COLORS.grid);
    }
  }

  private drawHorizon(world: World, p: Projection, s: LayerSettings) {
    const rh = world.spacetime.horizonRadius;
    if (rh === null) return;
    const c = COLORS.horizon;
    if (p.showsTime) {
      // Its cross-section with the field plane, swept through time: a cylinder.
      const offset = p.slice;
      if (Math.abs(offset) >= rh) return;
      const rho = Math.sqrt(rh * rh - offset * offset);
      const at = (th: number, t: number): Vec4 => {
        const e = p.fieldEvent(rho * Math.cos(th), rho * Math.sin(th));
        e[0] = t;
        return e;
      };
      for (let k = 0; k <= 8; k++) {
        const t = p.now - (k * s.window) / 8;
        for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
          const th = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
          this.segment(this.lines, p, at(th, t), at(th + (2 * Math.PI) / CIRCLE_SEGMENTS, t), c, 0.6);
        }
      }
      for (let i = 0; i < 12; i++) {
        const th = (2 * Math.PI * i) / 12;
        this.segment(this.lines, p, at(th, p.now - s.window), at(th, p.now), c, 0.4);
      }
    } else {
      const sph = (th: number, ph: number): Vec4 => [
        p.now,
        rh * Math.sin(th) * Math.cos(ph),
        rh * Math.sin(th) * Math.sin(ph),
        rh * Math.cos(th),
      ];
      for (let i = 1; i < 6; i++) {
        const th = (Math.PI * i) / 6;
        for (let k = 0; k < CIRCLE_SEGMENTS; k++) {
          const ph = (2 * Math.PI * k) / CIRCLE_SEGMENTS;
          this.segment(this.lines, p, sph(th, ph), sph(th, ph + (2 * Math.PI) / CIRCLE_SEGMENTS), c, 0.6);
        }
      }
    }
  }

  /** Axes of the display frame, through the origin at "now". */
  private drawAxes(p: Projection, s: LayerSettings) {
    const E = s.extent * 1.15;
    const c = COLORS.axis;
    const ax = this.axes;
    ax.vertex(-E, 0, 0, c);
    ax.vertex(E, 0, 0, c);
    ax.vertex(0, 0, E, c);
    ax.vertex(0, 0, -E, c);
    const vTop = p.showsTime ? Math.max(coneSize(s) * 1.5, 2) * p.timeScale : E;
    const vBottom = p.showsTime ? -s.window * p.timeScale : -E;
    ax.vertex(0, vBottom, 0, c);
    ax.vertex(0, vTop, 0, c);

    const prime = p.showsTime && p.boost !== 0 ? '′' : '';
    this.labels.h1.position.set(E * 1.04, 0, 0);
    this.labels.h2.position.set(0, 0, -E * 1.04);
    this.labels.v.position.set(0, vTop * 1.04 + 0.5, 0);
    setText(this.labels.h1, p.axisName('h1') + prime);
    setText(this.labels.h2, p.axisName('h2'));
    setText(this.labels.v, p.axisName('v') + prime);
  }

  private segment(buf: LineBuffer, p: Projection, a: Vec4, b: Vec4, c: THREE.Color, brightness = 1) {
    buf.segment(p, a, b, c, brightness);
  }

  /**
   * The time-warp surface. Circles around it are places (constant r); lines down it are
   * moments (constant static time), which rotate as time passes. Static clocks sit on the
   * circles, ticking every Δτ of their own time: further apart near the mass, where the
   * surface is wider. The white curve is the simulation's "now".
   */
  private drawEmbedding(p: Projection, s: LayerSettings, hasMass: boolean) {
    const e = p.embedding;
    if (!e) {
      this.setLabels('', '', 'No time-warp embedding for this spacetime', [0, 0, 0], [0, 0, 0], [0, 0, 0]);
      return;
    }
    if (this.surfaceFor !== e) this.buildSurface(e);
    const out = [0, 0, 0];
    const vertexAt = (buf: LineBuffer | PointBuffer, t: number, r: number, c: THREE.Color, b = 1) => {
      if (e.place(t, r, out)) buf.vertex(out[0], out[1], out[2], c, b);
    };
    const rAt = (k: number, n: number) => e.rInner + ((e.rOuter - e.rInner) * k) / n;

    if (s.fieldGrid) {
      const step = niceStep((e.rOuter - e.rInner) / 6);
      const radii = [e.rInner, e.rOuter];
      for (let r = Math.ceil(e.rInner / step) * step; r < e.rOuter; r += step) radii.push(r);
      for (const r of radii) {
        for (let k = 0; k < 96; k++) {
          vertexAt(this.faint, (k / 96) * e.wrapTime, r, COLORS.surfaceLine);
          vertexAt(this.faint, ((k + 1) / 96) * e.wrapTime, r, COLORS.surfaceLine);
        }
      }
      // Lines of constant static time, every 1/24 of a turn, drifting round as time passes.
      const dt = e.wrapTime / 24;
      for (let m = Math.ceil((p.now - e.wrapTime) / dt); m * dt <= p.now; m++) {
        for (let k = 0; k < 48; k++) {
          vertexAt(this.faint, m * dt - p.now, rAt(k, 48), COLORS.surfaceLine);
          vertexAt(this.faint, m * dt - p.now, rAt(k + 1, 48), COLORS.surfaceLine);
        }
      }
    }

    // "Now" in simulation time: the slice where the body markers sit.
    for (let k = 0; k < 60; k++) {
      this.lines.segment(p, [p.now, rAt(k, 60), 0, 0], [p.now, rAt(k + 1, 60), 0, 0], COLORS.now, 0.7);
    }

    if (s.clocks) {
      for (let r = e.rInner; r <= e.rOuter + 1e-9; r += s.clockSpacing) {
        const rate = Math.sqrt(e.chart.lapseSquared(r));
        const color = this.tmpColor.copy(COLORS.clockSlow).lerp(COLORS.clockFast, rate ** 6);
        const tNow = e.chart.staticTime(p.now, r);
        const dTau = s.tickInterval;
        for (let m = Math.ceil(((tNow - s.window) * rate) / dTau); m * dTau <= tNow * rate; m++) {
          vertexAt(this.ticks, (m * dTau) / rate - p.now, r, color);
        }
      }
    }

    this.setLabels(
      hasMass ? `r = ${fmt(e.rInner)}M (toward the mass)` : `r = ${fmt(e.rInner)}`,
      `r = ${fmt(e.rOuter)}${hasMass ? 'M' : ''}`,
      'time runs around ↺',
      [e.radiusAt(e.rInner) * 1.08, e.bottom, 0],
      [e.radiusAt(e.rOuter) * 1.08, 0, 0],
      [0, e.maxRadius * 0.2, 0],
    );
  }

  private buildSurface(e: TimeEmbedding) {
    const pts: THREE.Vector2[] = [];
    for (let k = 0; k <= 120; k++) {
      const r = e.rInner + ((e.rOuter - e.rInner) * k) / 120;
      pts.push(new THREE.Vector2(e.radiusAt(r), e.heightAt(r)));
    }
    this.surface.geometry.dispose();
    this.surface.geometry = new THREE.LatheGeometry(pts, 96);
    this.surfaceFor = e;
  }

  private setLabels(h1: string, h2: string, v: string, p1: number[], p2: number[], pv: number[]) {
    setText(this.labels.h1, h1);
    setText(this.labels.h2, h2);
    setText(this.labels.v, v);
    this.labels.h1.position.set(p1[0], p1[1], p1[2]);
    this.labels.h2.position.set(p2[0], p2[1], p2[2]);
    this.labels.v.position.set(pv[0], pv[1], pv[2]);
  }
}

/** Coordinate time the drawn light cones reach into the future: sized so neighbours don't overlap. */
function coneSize(s: LayerSettings) {
  return 0.4 * s.coneSpacing;
}

/** Body position at coordinate time t (its live state if t is at or past its last record). */
function positionAt(b: Body, t: number, out: number[]) {
  if (b.alive && t >= b.latestT - 1e-9) {
    out[0] = b.x[0];
    out[1] = b.x[1];
    out[2] = b.x[2];
    out[3] = b.x[3];
    return true;
  }
  return b.sampleAt(t, out);
}

function* lattice(extent: number, spacing: number): Generator<[number, number]> {
  const n = Math.floor(extent / spacing);
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) yield [i * spacing, j * spacing];
}

function niceStep(x: number) {
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function fmt(r: number) {
  return `${Number(r.toFixed(1))}`;
}

function makeLabel() {
  const div = document.createElement('div');
  div.className = 'axis-label';
  return new CSS2DObject(div);
}

function setText(label: CSS2DObject, text: string) {
  if (label.element.textContent !== text) label.element.textContent = text;
}
