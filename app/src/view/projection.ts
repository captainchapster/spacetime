import type { TimeEmbedding } from '../physics/embedding';
import type { Vec4 } from '../physics/linalg';

/**
 * Which three of the four coordinates are drawn (the fourth is hidden), or 'embed':
 * the (t, r) plane drawn as the curved time-warp surface.
 */
export type AxisSet = 'txy' | 'txz' | 'tyz' | 'xyz' | 'embed';

export const AXIS_NAMES = ['ct', 'x', 'y', 'z'] as const;

interface Layout {
  /** Coordinate index drawn along screen-horizontal X. */
  h1: number;
  /** Coordinate index drawn along screen depth (−Z), completing a right-handed frame. */
  h2: number;
  /** Coordinate index drawn vertically (Y). */
  v: number;
  hidden: number;
}

const LAYOUTS: Record<AxisSet, Layout> = {
  txy: { h1: 1, h2: 2, v: 0, hidden: 3 },
  txz: { h1: 1, h2: 3, v: 0, hidden: 2 },
  tyz: { h1: 2, h2: 3, v: 0, hidden: 1 },
  xyz: { h1: 1, h2: 2, v: 3, hidden: 0 },
  embed: { h1: 1, h2: 2, v: 0, hidden: 3 }, // only used for picking/defaults
};

/**
 * Maps events (t, x, y, z) to display space.
 *
 * Bodies are *projected*: the hidden coordinate is simply dropped, so every worldline
 * stays visible. Fields (light cones, clocks, grids) are *sampled* on the field plane:
 *  - spacetime views (ct up): the "now" slice t = now, at hidden coordinate = `slice`
 *  - space view (x, y, z): the plane z = `slice` at t = now
 *
 * In spacetime views "now" sits at height 0 and the past extends downward. An optional
 * Lorentz boost along the first displayed spatial axis re-draws everything as seen in a
 * frame moving at `boost`·c relative to the simulation's coordinates.
 *
 * The 'embed' view is non-linear: each event goes to its (static time, r) spot on the
 * time-warp surface, and events off the surface are not drawn (project returns false).
 */
export class Projection {
  axes: AxisSet = 'txy';
  now = 0;
  slice = 0;
  /** Display units per unit of ct (1 keeps flat light cones at 45°). */
  timeScale = 1;
  boost = 0;
  embedding: TimeEmbedding | null = null;

  get layout(): Layout {
    return LAYOUTS[this.axes];
  }

  get showsTime() {
    return this.axes !== 'xyz';
  }

  get isEmbed() {
    return this.axes === 'embed';
  }

  /** History that can be shown: on the embedding, less than one turn so time doesn't overlap. */
  visibleWindow(window: number) {
    return this.isEmbed && this.embedding ? Math.min(window, 0.95 * this.embedding.wrapTime) : window;
  }

  axisName(role: 'h1' | 'h2' | 'v' | 'hidden') {
    return AXIS_NAMES[this.layout[role]];
  }

  /**
   * Write the display position of event (t, x, y, z) into out[o], out[o+1], out[o+2].
   * Returns false if this view can't show the event.
   */
  project(t: number, x: number, y: number, z: number, out: Float32Array | number[], o = 0): boolean {
    if (this.isEmbed) {
      const e = this.embedding;
      if (!e) return false;
      const r = Math.hypot(x, y, z);
      return e.place(e.chart.staticTime(t, r) - this.now, r, out, o);
    }
    const L = this.layout;
    const e = [t - this.now, x, y, z];
    let a = e[L.h1];
    const b = e[L.h2];
    let v = e[L.v];
    if (this.showsTime) {
      if (this.boost !== 0) {
        const g = 1 / Math.sqrt(1 - this.boost * this.boost);
        const tb = g * (v - this.boost * a);
        a = g * (a - this.boost * v);
        v = tb;
      }
      v *= this.timeScale;
    }
    out[o] = a;
    out[o + 1] = v;
    out[o + 2] = -b;
    return true;
  }

  /** The event on the field plane at displayed horizontal coordinates (a, b). */
  fieldEvent(a: number, b: number): Vec4 {
    const L = this.layout;
    const e: Vec4 = [this.now, 0, 0, 0];
    if (this.showsTime) {
      e[L.h1] = a;
      e[L.h2] = b;
      e[L.hidden] = this.slice;
    } else {
      e[1] = a;
      e[2] = b;
      e[3] = this.slice;
    }
    return e;
  }

  /** Spatial coordinate indices spanning the field plane. */
  get fieldAxes(): [number, number] {
    return this.showsTime ? [this.layout.h1, this.layout.h2] : [1, 2];
  }

  /** Display height of the field plane (ignoring any boost), for mouse picking. */
  get fieldPlaneY() {
    return this.showsTime ? 0 : this.slice;
  }
}
