/**
 * Build the real-sky assets in public/sky/ (run: npm run fetch-sky).
 *
 *  - Milky Way background: NASA/GSFC SVS "Deep Star Maps 2020", milkyway_2020 (the star map
 *    without the bright Hipparcos/Tycho stars), galactic coordinates, linear HDR → an 8-bit
 *    gamma-encoded WebP the browser can load and mipmap.
 *  - Stars: the Hipparcos-2 catalogue (van Leeuwen 2007, VizieR I/311), ~118,000 stars, as
 *    galactic unit vectors with flux and colour temperature, drawn as exact points.
 *  - Calibration: star flux is put in the map's units by measuring the same stars in NASA's
 *    bright-star layer (hiptyc_2020), which also checks our coordinate conversion lands each
 *    catalogue star on its image.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import sharp from 'sharp';
import { bvToTemperature, galacticUV, radecToGalactic } from '../src/physics/sky.ts';

const SRC = 'sky-src';
const OUT = 'public/sky';
const SVS = 'https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851';
const HIP2 =
  'https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=I/311/hip2&-out=HIP&-out=RArad&-out=DErad&-out=Hpmag&-out=B-V&-out.max=unlimited';
const GAMMA = 2.6;

mkdirSync(SRC, { recursive: true });
mkdirSync(OUT, { recursive: true });

async function fetchOnce(file, url) {
  const path = `${SRC}/${file}`;
  if (existsSync(path)) return path;
  console.log(`downloading ${file} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

/**
 * Decode an EXR into top-down rows (row 0 = the top of the image, b = +90°). Three's loader
 * returns rows bottom-up, the WebGL convention, so flip them back.
 */
function decodeExr(path) {
  const buf = readFileSync(path);
  const img = new EXRLoader().setDataType(THREE.FloatType).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const { width: w, height: h } = img;
  const ch = img.data.length / (w * h);
  const data = new Float32Array(img.data.length);
  for (let y = 0; y < h; y++) data.set(img.data.subarray((h - 1 - y) * w * ch, (h - y) * w * ch), y * w * ch);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (data[i * ch] + data[i * ch + 1] + data[i * ch + 2]) / 3;
  return { width: w, height: h, data, ch, lum };
}

const mwPath = await fetchOnce('milkyway_2020_4k_gal.exr', `${SVS}/milkyway_2020_4k_gal.exr`);
const htPath = await fetchOnce('hiptyc_2020_4k_gal.exr', `${SVS}/hiptyc_2020_4k_gal.exr`);
const hipPath = await fetchOnce('hip2.tsv', HIP2);

// ---------------------------------------------------------------- the catalogue

const stars = [];
for (const line of readFileSync(hipPath, 'utf8').split('\n')) {
  if (!/^\s*\d/.test(line)) continue;
  const [hip, ra, dec, hp, bv] = line.split('\t').map((s) => s.trim());
  if (!ra || !dec || !hp) continue;
  stars.push({ hip: +hip, g: radecToGalactic(+ra, +dec), hp: +hp, bv: bv === '' ? NaN : +bv });
}
console.log(`catalogue: ${stars.length} stars`);

// ---------------------------------------------------------------- calibration

const ht = decodeExr(htPath);
const W = ht.width;
const H = ht.height;
const pixelOf = (g) => {
  const [u, v] = galacticUV(g);
  return [u * W - 0.5, v * H - 0.5]; // pixel centres at integer + 0.5
};
// How many catalogue stars brighter than mag 10 fall in each pixel (to pick isolated ones).
const crowd = new Uint16Array(W * H);
for (const s of stars) {
  if (s.hp > 10) continue;
  const [x, y] = pixelOf(s.g).map(Math.round);
  if (x >= 0 && x < W && y >= 0 && y < H) crowd[y * W + x]++;
}
const R = 4;
const samples = [];
let offsetSum = 0;
let offsetX = 0;
let offsetY = 0;
for (const s of stars) {
  if (s.hp < 4.5 || s.hp > 7.5) continue;
  const [px, py] = pixelOf(s.g);
  const cx = Math.round(px);
  const cy = Math.round(py);
  if (cy - R < 1 || cy + R > H - 2 || cx - R < 0 || cx + R >= W) continue;
  if (Math.abs(90 - (Math.abs(py / H - 0.5) * 180)) < 20) continue; // skip near the poles
  let neighbours = 0;
  for (let dy = -2 * R; dy <= 2 * R; dy++) for (let dx = -2 * R; dx <= 2 * R; dx++) neighbours += crowd[(cy + dy) * W + ((cx + dx + W) % W)] ?? 0;
  if (neighbours !== 1) continue;
  let S = 0;
  let mx = 0;
  let my = 0;
  let peak = 0;
  for (let dy = -R; dy <= R; dy++) {
    const b = ((0.5 - (cy + dy + 0.5) / H) * Math.PI);
    const dOmega = ((2 * Math.PI) / W) * (Math.PI / H) * Math.cos(b);
    for (let dx = -R; dx <= R; dx++) {
      const L = ht.lum[(cy + dy) * W + cx + dx];
      S += L * dOmega;
      mx += L * dx;
      my += L * dy;
      peak = Math.max(peak, L);
    }
  }
  if (peak >= 0.95 || S <= 0) continue; // saturated or missing
  const sum = S / (((2 * Math.PI) / W) * (Math.PI / H) * Math.cos(((0.5 - (cy + 0.5) / H) * Math.PI)));
  offsetSum += Math.hypot(cx + mx / sum - px, cy + my / sum - py);
  offsetX += cx + mx / sum - px;
  offsetY += cy + my / sum - py;
  samples.push({ hp: s.hp, c: S / 10 ** (-0.4 * s.hp) });
}
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const fluxScale = median(samples.map((s) => s.c));
const meanOffset = offsetSum / samples.length;
console.log(
  `calibration: ${samples.length} isolated stars, mean centroid offset ${meanOffset.toFixed(2)} px` +
    ` (mean dx ${(offsetX / samples.length).toFixed(2)}, dy ${(offsetY / samples.length).toFixed(2)})`,
);
for (let m = 4.5; m < 7.5; m += 0.5) {
  const bin = samples.filter((s) => s.hp >= m && s.hp < m + 0.5).map((s) => s.c / fluxScale);
  if (bin.length) console.log(`  mag ${m.toFixed(1)}–${(m + 0.5).toFixed(1)}: ${bin.length} stars, flux / fit = ${median(bin).toFixed(3)}`);
}
if (meanOffset > 1.0) throw new Error('Catalogue stars do not land on the map: coordinate convention is off.');

// ---------------------------------------------------------------- outputs

const mw = decodeExr(mwPath);
const rgb = Buffer.alloc(mw.width * mw.height * 3);
for (let i = 0; i < mw.width * mw.height; i++) {
  for (let k = 0; k < 3; k++) {
    const v = Math.max(0, Math.min(1, mw.data[i * mw.ch + k]));
    rgb[i * 3 + k] = Math.round(255 * v ** (1 / GAMMA));
  }
}
await sharp(rgb, { raw: { width: mw.width, height: mw.height, channels: 3 } })
  .webp({ quality: 92 })
  .toFile(`${OUT}/milkyway.webp`);

const data = new Float32Array(stars.length * 5);
stars.forEach((s, i) => {
  data.set([...s.g, fluxScale * 10 ** (-0.4 * s.hp), bvToTemperature(Number.isFinite(s.bv) ? s.bv : 0.65)], i * 5);
});
writeFileSync(`${OUT}/stars.bin`, Buffer.from(data.buffer));
writeFileSync(
  `${OUT}/sky.json`,
  JSON.stringify(
    {
      gamma: GAMMA,
      width: mw.width,
      height: mw.height,
      stars: stars.length,
      starFluxUnit: 'map value × steradian',
      calibration: { stars: samples.length, centroidOffsetPx: +meanOffset.toFixed(3), fluxScale },
      credits: [
        'Milky Way: NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020. Gaia DR2: ESA/Gaia/DPAC.',
        'Stars: Hipparcos, the New Reduction (van Leeuwen 2007), via VizieR (CDS, Strasbourg).',
      ],
    },
    null,
    2,
  ),
);
console.log(`wrote ${OUT}/milkyway.webp, stars.bin (${stars.length} stars), sky.json`);
