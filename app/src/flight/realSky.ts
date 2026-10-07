import { CELL_ANGLE, STAR_GRID, type V3, binStars } from '../physics/sky';

/** Grid margin (radians): every star within this of a direction is listed in its cell. */
export const STAR_MARGIN = 0.6 * CELL_ANGLE;

export interface RealSkyData {
  image: HTMLImageElement;
  gamma: number;
  width: number;
  /** Per grid cell (RGBA texels, INDEX_W wide): first list entry, count. */
  index: Float32Array;
  indexRows: number;
  /** Star indices sorted by cell (R texels, LIST_W wide). */
  list: Float32Array;
  listRows: number;
  /** Per star, two RGBA texels (DATA_W wide): (gx, gy, gz, flux), (T, 0, 0, 0). */
  data: Float32Array;
  dataRows: number;
  stars: number;
  credits: string[];
}

export const INDEX_W = 512;
export const LIST_W = 4096;
export const DATA_W = 4096;

/**
 * Load the real-sky assets built by `npm run fetch-sky` (public/sky/). Returns null if they
 * haven't been built, so the app can fall back to the procedural sky.
 */
export async function loadRealSky(): Promise<RealSkyData | null> {
  let meta: { gamma: number; width: number; credits: string[] };
  try {
    const res = await fetch('/sky/sky.json');
    if (!res.ok) return null;
    meta = await res.json();
  } catch {
    return null;
  }
  const image = new Image();
  image.src = '/sky/milkyway.webp';
  const [buf] = await Promise.all([fetch('/sky/stars.bin').then((r) => r.arrayBuffer()), image.decode()]);
  const raw = new Float32Array(buf);
  const n = raw.length / 5;
  const dirs: V3[] = [];
  for (let i = 0; i < n; i++) dirs.push([raw[5 * i], raw[5 * i + 1], raw[5 * i + 2]]);

  const { index: cells, list: entries } = binStars(dirs, STAR_MARGIN);
  const cellCount = 6 * STAR_GRID * STAR_GRID;
  const indexRows = Math.ceil(cellCount / INDEX_W);
  const index = new Float32Array(INDEX_W * indexRows * 4);
  for (let c = 0; c < cellCount; c++) {
    index[4 * c] = cells[2 * c];
    index[4 * c + 1] = cells[2 * c + 1];
  }
  const listRows = Math.ceil(entries.length / LIST_W);
  const list = new Float32Array(LIST_W * listRows);
  list.set(entries);
  const dataRows = Math.ceil((2 * n) / DATA_W);
  const data = new Float32Array(DATA_W * dataRows * 4);
  for (let i = 0; i < n; i++) {
    data.set([raw[5 * i], raw[5 * i + 1], raw[5 * i + 2], raw[5 * i + 3]], 8 * i);
    data[8 * i + 4] = raw[5 * i + 4];
  }
  return { image, gamma: meta.gamma, width: meta.width, index, indexRows, list, listRows, data, dataRows, stars: n, credits: meta.credits };
}

/**
 * Simulation → galactic rotation, as a column-major mat3. With no yaw or tilt, looking along
 * +y (the default view, past the hole) faces the Galactic Centre, with the galactic north
 * pole up along +z. Tilt rolls the sky about that line of sight; yaw turns it about +z.
 */
export function skyMatrix(yawDeg: number, tiltDeg: number): Float32Array {
  const y = (yawDeg * Math.PI) / 180;
  const t = (tiltDeg * Math.PI) / 180;
  const M0 = [
    [0, 1, 0],
    [-1, 0, 0],
    [0, 0, 1],
  ];
  const Rz = [
    [Math.cos(y), -Math.sin(y), 0],
    [Math.sin(y), Math.cos(y), 0],
    [0, 0, 1],
  ];
  const Ry = [
    [Math.cos(t), 0, Math.sin(t)],
    [0, 1, 0],
    [-Math.sin(t), 0, Math.cos(t)],
  ];
  const mul = (A: number[][], B: number[][]) => A.map((row) => [0, 1, 2].map((j) => row.reduce((s, v, k) => s + v * B[k][j], 0)));
  const M = mul(mul(M0, Rz), Ry);
  return Float32Array.from([0, 1, 2].flatMap((col) => [M[0][col], M[1][col], M[2][col]]));
}
