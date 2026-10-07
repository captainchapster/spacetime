/**
 * The real sky: coordinate conversions, star colours, and the cube-face grid used to find
 * catalogue stars quickly (mirrored in the GPU shader). Shared by the build script
 * (scripts/build-sky.mjs) and the renderer.
 */

export type V3 = [number, number, number];

/**
 * ICRS (J2000 equatorial) → galactic rotation, as in the Hipparcos/Gaia documentation (the
 * transformation NASA's galactic sky maps use). Rows are the galactic axes: toward the
 * Galactic Centre, toward l = 90°, and the North Galactic Pole.
 */
export const ICRS_TO_GALACTIC = [
  [-0.0548755604162154, -0.873437090234885, -0.4838350155487132],
  [0.4941094278755837, -0.4448296299600112, 0.7469822444972189],
  [-0.8676661490190047, -0.1980763734312015, 0.4559837761750669],
];

export function radecToGalactic(raDeg: number, decDeg: number): V3 {
  const a = (raDeg * Math.PI) / 180;
  const d = (decDeg * Math.PI) / 180;
  const r = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  return ICRS_TO_GALACTIC.map((row) => row[0] * r[0] + row[1] * r[1] + row[2] * r[2]) as V3;
}

/** Galactic longitude/latitude in degrees, l in (−180, 180]. */
export function galacticLB(g: V3) {
  return { l: (Math.atan2(g[1], g[0]) * 180) / Math.PI, b: (Math.asin(Math.max(-1, Math.min(1, g[2]))) * 180) / Math.PI };
}

/**
 * Texture coordinates in NASA's galactic plate carrée maps: centred on l = 0, longitude
 * increasing to the left, b = +90° along the top row (t = 0).
 */
export function galacticUV(g: V3): [number, number] {
  const { l, b } = galacticLB(g);
  return [(((0.5 - l / 360) % 1) + 1) % 1, 0.5 - b / 180];
}

/**
 * Effective temperature from the B−V colour index (Ballesteros 2012), as NASA's maps use.
 * It undershoots for the hottest stars (~16,600 K at B−V = −0.3), where colour barely changes.
 */
export function bvToTemperature(bv: number) {
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}

/** Cells per cube-face edge in the star lookup grid. */
export const STAR_GRID = 128;

/** The lookup cell containing direction d: face 0..5 (±x, ±y, ±z), then row and column. */
export function skyCell(d: V3) {
  const ax = Math.abs(d[0]);
  const ay = Math.abs(d[1]);
  const az = Math.abs(d[2]);
  let face: number;
  let u: number;
  let v: number;
  if (ax >= ay && ax >= az) {
    face = d[0] > 0 ? 0 : 1;
    u = d[1] / ax;
    v = d[2] / ax;
  } else if (ay >= az) {
    face = d[1] > 0 ? 2 : 3;
    u = d[0] / ay;
    v = d[2] / ay;
  } else {
    face = d[2] > 0 ? 4 : 5;
    u = d[0] / az;
    v = d[1] / az;
  }
  const i = Math.min(STAR_GRID - 1, Math.floor((u * 0.5 + 0.5) * STAR_GRID));
  const j = Math.min(STAR_GRID - 1, Math.floor((v * 0.5 + 0.5) * STAR_GRID));
  return (face * STAR_GRID + j) * STAR_GRID + i;
}

/** Angular size of a grid cell at a face centre (radians); cells near face edges are smaller. */
export const CELL_ANGLE = (2 / STAR_GRID) * 0.8;

/**
 * Bin stars into the grid so a lookup of a direction's own cell finds every star within
 * `margin` radians of it: each star is also listed in the cells of nearby directions.
 * Returns per-cell [offset, count] and the flattened list of star indices.
 */
export function binStars(dirs: V3[], margin: number) {
  const cells = 6 * STAR_GRID * STAR_GRID;
  const lists = new Map<number, number[]>();
  dirs.forEach((d, s) => {
    // Two tangent directions at the star.
    const ref: V3 = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const t1 = normalize(cross(d, ref));
    const t2 = cross(d, t1);
    const seen = new Set<number>();
    const steps = [-1, -0.5, 0, 0.5, 1];
    for (const a of steps) {
      for (const b of steps) {
        const p = normalize([0, 1, 2].map((k) => d[k] + margin * (a * t1[k] + b * t2[k])) as V3);
        const c = skyCell(p);
        if (seen.has(c)) continue;
        seen.add(c);
        let list = lists.get(c);
        if (!list) lists.set(c, (list = []));
        list.push(s);
      }
    }
  });
  const index = new Uint32Array(cells * 2);
  const flat: number[] = [];
  for (let c = 0; c < cells; c++) {
    const list = lists.get(c) ?? [];
    index[2 * c] = flat.length;
    index[2 * c + 1] = list.length;
    flat.push(...list);
  }
  return { index, list: Uint32Array.from(flat) };
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(a: V3): V3 {
  const n = Math.hypot(...a);
  return [a[0] / n, a[1] / n, a[2] / n];
}
