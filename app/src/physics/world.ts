import { Body, type IntegratorConfig } from './body';
import { fourVelocity, nullTangent } from './geodesic';
import type { Vec4 } from './linalg';
import type { Spacetime } from './spacetime';

export type Vec3 = [number, number, number];

/** A lattice of dust particles released together; views draw lines between neighbours. */
export interface DustGrid {
  cols: number;
  rows: number;
  /** Row-major, length cols × rows. */
  bodies: Body[];
}

const PALETTE = [0x5ec8ff, 0xff7aa8, 0x9dff7a, 0xc69bff, 0xff9f5a, 0x5affd5, 0xfff07a, 0xff5a5a];

/** The simulation: one spacetime, a set of test bodies, and the current coordinate time. */
export class World {
  time = 0;
  bodies: Body[] = [];
  grids: DustGrid[] = [];
  /** Worldline history older than this (coordinate time) is discarded. */
  retain = 2000;
  config: IntegratorConfig = {
    stepFraction: 0.01,
    maxStep: 0.5,
    recordInterval: 0.25,
    maxStepsPerCall: 4000,
    escapeRadius: 5000,
  };
  private colorIndex = 0;

  constructor(readonly spacetime: Spacetime) {}

  advance(dt: number) {
    this.time += dt;
    const cutoff = this.time - this.retain;
    for (const b of this.bodies) {
      b.advanceTo(this.spacetime, this.time, this.config);
      b.trimBefore(cutoff);
    }
  }

  nextColor() {
    return PALETTE[this.colorIndex++ % PALETTE.length];
  }

  /** Add a massive body at `pos` (now) with coordinate velocity `vel` = dx/dt. Throws if invalid. */
  addParticle(pos: Vec3, vel: Vec3, opts: { color?: number; label?: string } = {}): Body {
    const x: Vec4 = [this.time, ...pos];
    if (this.spacetime.isSingular(x)) throw new Error('That position is at a singularity.');
    const u = fourVelocity(this.spacetime, x, vel);
    if (!u) throw new Error('That velocity is not slower than light at this position.');
    const body = new Body('massive', x, u, opts.color ?? this.nextColor(), opts.label);
    this.bodies.push(body);
    return body;
  }

  /** Emit a light ray from `pos` (now) in spatial direction `dir`. Throws if invalid. */
  addPhoton(pos: Vec3, dir: Vec3, opts: { color?: number; label?: string } = {}): Body {
    const x: Vec4 = [this.time, ...pos];
    if (this.spacetime.isSingular(x)) throw new Error('That position is at a singularity.');
    const u = nullTangent(this.spacetime, x, dir);
    if (!u) throw new Error('Light cannot travel in that direction from here.');
    const body = new Body('photon', x, u, opts.color ?? 0xffe27a, opts.label);
    this.bodies.push(body);
    return body;
  }

  /**
   * Release a cols × rows lattice of dust at rest, spanning spatial axes `axisA` and `axisB`
   * (1 = x, 2 = y, 3 = z) around `centre`.
   */
  addDustGrid(centre: Vec3, axisA: 1 | 2 | 3, axisB: 1 | 2 | 3, cols: number, rows: number, spacing: number) {
    const bodies: Body[] = [];
    const color = this.nextColor();
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const p: Vec3 = [...centre];
        p[axisA - 1] += (i - (cols - 1) / 2) * spacing;
        p[axisB - 1] += (j - (rows - 1) / 2) * spacing;
        bodies.push(this.addParticle(p, [0, 0, 0], { color }));
      }
    }
    const grid = { cols, rows, bodies };
    this.grids.push(grid);
    return grid;
  }

  clear() {
    this.bodies = [];
    this.grids = [];
  }
}
