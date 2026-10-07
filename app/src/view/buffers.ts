import * as THREE from 'three';
import type { Projection } from './projection';

/**
 * A growable, per-frame-rebuilt vertex buffer behind one Three.js draw call.
 * Every frame: `begin()`, push vertices (already projected or as events), `end()`.
 */
abstract class DynamicBuffer<T extends THREE.Object3D> {
  readonly object: T;
  protected geometry = new THREE.BufferGeometry();
  private pos = new Float32Array(0);
  private col = new Float32Array(0);
  private count = 0;
  protected tmp = [0, 0, 0];

  constructor(make: (geometry: THREE.BufferGeometry) => T) {
    this.object = make(this.geometry);
    this.object.frustumCulled = false;
    this.grow(1024);
  }

  begin() {
    this.count = 0;
  }

  /** Push a vertex in display coordinates. */
  vertex(x: number, y: number, z: number, c: THREE.Color, brightness = 1) {
    if (this.count >= this.pos.length / 3) this.grow(this.count * 2);
    const i = this.count * 3;
    this.pos[i] = x;
    this.pos[i + 1] = y;
    this.pos[i + 2] = z;
    this.col[i] = c.r * brightness;
    this.col[i + 1] = c.g * brightness;
    this.col[i + 2] = c.b * brightness;
    this.count++;
  }

  /** Push a vertex given as a spacetime event; skipped if the view can't show that event. */
  event(p: Projection, t: number, x: number, y: number, z: number, c: THREE.Color, brightness = 1) {
    if (!p.project(t, x, y, z, this.tmp)) return false;
    this.vertex(this.tmp[0], this.tmp[1], this.tmp[2], c, brightness);
    return true;
  }

  end() {
    this.geometry.setDrawRange(0, this.count);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  private grow(vertices: number) {
    const pos = new Float32Array(vertices * 3);
    const col = new Float32Array(vertices * 3);
    pos.set(this.pos);
    col.set(this.col);
    this.pos = pos;
    this.col = col;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  }
}

/** Line segments: vertices are consumed in pairs. */
export class LineBuffer extends DynamicBuffer<THREE.LineSegments> {
  private tmpB = [0, 0, 0];

  /** A segment between two events (t, x, y, z, …); dropped unless both ends are visible. */
  segment(p: Projection, a: ArrayLike<number>, b: ArrayLike<number>, c: THREE.Color, ba = 1, bb = ba) {
    const A = this.tmp;
    const B = this.tmpB;
    if (!p.project(a[0], a[1], a[2], a[3], A) || !p.project(b[0], b[1], b[2], b[3], B)) return;
    this.vertex(A[0], A[1], A[2], c, ba);
    this.vertex(B[0], B[1], B[2], c, bb);
  }

  constructor(opacity = 1) {
    super(
      (g) =>
        new THREE.LineSegments(
          g,
          new THREE.LineBasicMaterial({ vertexColors: true, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }),
        ),
    );
  }
}

export class PointBuffer extends DynamicBuffer<THREE.Points> {
  constructor(size: number) {
    super(
      (g) => new THREE.Points(g, new THREE.PointsMaterial({ vertexColors: true, size, sizeAttenuation: false })),
    );
  }
}
