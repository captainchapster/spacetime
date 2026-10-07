import { describe, expect, it } from 'vitest';
import {
  type V3,
  CELL_ANGLE,
  binStars,
  bvToTemperature,
  galacticLB,
  galacticUV,
  radecToGalactic,
  skyCell,
} from '../src/physics/sky';

describe('real sky coordinates', () => {
  it('puts the Galactic Centre at l = b = 0 and the North Galactic Pole at b = 90°', () => {
    // IAU positions (ICRS): Sgr A* region / galactic centre, and the NGP.
    const gc = galacticLB(radecToGalactic(266.40499, -28.93617));
    expect(gc.l).toBeCloseTo(0, 3);
    expect(gc.b).toBeCloseTo(0, 3);
    expect(galacticLB(radecToGalactic(192.85948, 27.12825)).b).toBeCloseTo(90, 3);
    // Sirius: l = 227.23°, b = −8.89° (SIMBAD).
    const sirius = galacticLB(radecToGalactic(101.28715533, -16.71611586));
    expect(sirius.l + 360).toBeCloseTo(227.23, 1);
    expect(sirius.b).toBeCloseTo(-8.89, 1);
  });

  it('maps galactic directions onto NASA\'s map layout (centred on l = 0, l increasing leftward)', () => {
    expect(galacticUV([1, 0, 0])).toEqual([0.5, 0.5]);
    const [u, v] = galacticUV(radecToGalactic(192.85948, 27.12825));
    expect(v).toBeCloseTo(0, 6); // NGP along the top
    const [uLeft] = galacticUV([0, 1, 0]); // l = +90°
    expect(uLeft).toBeCloseTo(0.25, 9); // …is to the left of centre
    expect(Number.isFinite(u)).toBe(true);
  });

  it('gives the Sun (B−V = 0.65) a temperature near 5800 K', () => {
    expect(bvToTemperature(0.65)).toBeGreaterThan(5600);
    expect(bvToTemperature(0.65)).toBeLessThan(5900);
    // Hot blue stars: Ballesteros' formula undershoots (~16,600 K for B−V = −0.3, against
    // ~25,000 K+), but blackbody colour hardly changes above ~15,000 K.
    expect(bvToTemperature(-0.3)).toBeGreaterThan(15000);
    expect(bvToTemperature(1.6)).toBeLessThan(3800); // cool red (M-type) stars, ~3,650 K
  });
});

describe('star lookup grid (mirrored by the shader)', () => {
  it('finds every star within the margin by looking only in the query direction\'s own cell', () => {
    let seed = 3;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const unit = (v: V3): V3 => {
      const n = Math.hypot(...v);
      return [v[0] / n, v[1] / n, v[2] / n];
    };
    const stars = Array.from({ length: 4000 }, () => unit([rand(), rand(), rand()]));
    const margin = 0.6 * CELL_ANGLE;
    const { index, list } = binStars(stars, margin);
    for (let s = 0; s < stars.length; s++) {
      // A direction up to 0.9 × margin away from the star, in a random direction.
      const d = stars[s];
      const t = unit([rand(), rand(), rand()]);
      const k = t[0] * d[0] + t[1] * d[1] + t[2] * d[2];
      const perp = unit([t[0] - k * d[0], t[1] - k * d[1], t[2] - k * d[2]]);
      const q = unit([0, 1, 2].map((i) => d[i] + 0.9 * margin * perp[i]) as V3);
      const c = skyCell(q);
      const found = Array.from(list.subarray(index[2 * c], index[2 * c] + index[2 * c + 1]));
      expect(found).toContain(s);
    }
  });
});
