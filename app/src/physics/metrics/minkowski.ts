import { ETA, type Mat4, zeroChristoffel } from '../linalg';
import type { Spacetime } from '../spacetime';

/** Flat spacetime of special relativity: ds² = −dt² + dx² + dy² + dz². */
export class Minkowski implements Spacetime {
  readonly id = 'minkowski';
  readonly label = 'Flat (Minkowski)';
  readonly horizonRadius = null;
  readonly chart = { lapseSquared: () => 1, staticTime: (t: number) => t };

  metric(): Mat4 {
    return ETA.map((row) => [...row]);
  }

  christoffel() {
    return zeroChristoffel();
  }

  timescale() {
    return Infinity;
  }

  isSingular() {
    return false;
  }
}
