import { ETA, type Mat4, type Vec4 } from '../linalg';
import { type Spacetime, numericalChristoffel, spatialRadius } from '../spacetime';

/**
 * Spheroidal radius r of the Kerr–Schild point (x, y, z), the root of
 *   r⁴ − (ρ² − a²) r² − a² z² = 0,   ρ² = x² + y² + z².
 * Far away r ≈ ρ; surfaces of constant r are oblate spheroids. Matches Boyer–Lindquist r.
 */
export function kerrRadius(x: number, y: number, z: number, a: number) {
  const b = x * x + y * y + z * z - a * a;
  const s = Math.sqrt(0.25 * b * b + a * a * z * z);
  // Avoid cancellation when b < 0 (inside the ring's disc).
  const r2 = b >= 0 ? 0.5 * b + s : (a * a * z * z) / (s - 0.5 * b);
  return Math.sqrt(r2);
}

/**
 * A rotating black hole of mass M and spin a = χM, in Cartesian Kerr–Schild coordinates:
 *
 *   g_μν = η_μν + f l_μ l_ν,   f = 2M r³ / (r⁴ + a² z²),
 *   l_μ = (1, (r x + a y)/(r² + a²), (r y − a x)/(r² + a²), z / r)
 *
 * Regular across the horizon r₊ = M + √(M² − a²), like the Schwarzschild metric used
 * elsewhere (which this reduces to at a = 0). With these signs the hole's angular
 * momentum points along +z for a > 0 (it turns counterclockwise seen from above);
 * `test/kerr.test.ts` pins that down: only counterclockwise circular orbits survive
 * close in, where retrograde ones would have to outrun light.
 * The singularity is the ring r = 0, z = 0 (x² + y² = a²).
 */
export class Kerr implements Spacetime {
  readonly id = 'kerr';
  readonly label = 'Kerr black hole';

  constructor(
    readonly mass = 1,
    /** Dimensionless spin χ = a/M, in [0, 1). */
    readonly spin = 0.9,
  ) {}

  get a() {
    return this.spin * this.mass;
  }

  get horizonRadius() {
    return this.mass + Math.sqrt(this.mass * this.mass - this.a * this.a);
  }

  radius(x: ArrayLike<number>) {
    return kerrRadius(x[1], x[2], x[3], this.a);
  }

  metric(x: Vec4): Mat4 {
    const a = this.a;
    const [, X, Y, Z] = x;
    const r = kerrRadius(X, Y, Z, a);
    const f = (2 * this.mass * r * r * r) / (r ** 4 + a * a * Z * Z);
    const ra = r * r + a * a;
    const l = [1, (r * X + a * Y) / ra, (r * Y - a * X) / ra, Z / r];
    return ETA.map((row, i) => row.map((v, j) => v + f * l[i] * l[j]));
  }

  christoffel(x: Vec4) {
    const h = 1e-4 * Math.max(spatialRadius(x), this.mass);
    return numericalChristoffel((p) => this.metric(p), x, h, true);
  }

  timescale(x: Vec4) {
    const r = Math.max(this.radius(x), 0.05 * this.mass);
    return r * Math.sqrt(r / (2 * this.mass));
  }

  isSingular(x: Vec4) {
    return this.radius(x) < 0.1 * this.mass;
  }
}
