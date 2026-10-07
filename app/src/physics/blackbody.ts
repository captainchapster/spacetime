/**
 * Colour of thermal light. Because I_ν/ν³ is invariant along a ray, a blackbody at
 * temperature T seen with frequency ratio g looks exactly like a blackbody at g·T. So all
 * Doppler and gravitational shifts of thermal sources reduce to one table: the linear-sRGB
 * radiance of a blackbody at each temperature.
 */

const H = 6.62607015e-34;
const KB = 1.380649e-23;
const C = 299_792_458;

/** CIE 1931 2° colour-matching functions: multi-lobe fit of Wyman, Sloan & Shirley (2013). */
export function cie1931(nm: number): [number, number, number] {
  const g = (mu: number, s1: number, s2: number) => {
    const t = (nm - mu) / (nm < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  };
  return [
    1.056 * g(599.8, 37.9, 31.0) + 0.362 * g(442.0, 16.0, 26.7) - 0.065 * g(501.1, 20.4, 26.2),
    0.821 * g(568.8, 46.9, 40.5) + 0.286 * g(530.9, 16.3, 31.1),
    1.217 * g(437.0, 11.8, 36.0) + 0.681 * g(459.0, 26.0, 13.8),
  ];
}

/** Planck spectral radiance B_λ(T), W·sr⁻¹·m⁻²·m⁻¹. */
export function planck(nm: number, T: number) {
  const l = nm * 1e-9;
  return (2 * H * C * C) / l ** 5 / Math.expm1((H * C) / (l * KB * T));
}

/** CIE XYZ of blackbody radiance at T (W·sr⁻¹·m⁻², CMF-weighted; luminance = 683·Y cd/m²). */
export function blackbodyXYZ(T: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  const step = 5;
  for (let nm = 360; nm <= 830; nm += step) {
    const b = planck(nm, T) * step * 1e-9;
    const [x, y, z] = cie1931(nm);
    out[0] += b * x;
    out[1] += b * y;
    out[2] += b * z;
  }
  return out;
}

export function xyzToLinearSrgb([X, Y, Z]: [number, number, number]): [number, number, number] {
  return [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.204 * Y + 1.057 * Z,
  ];
}

/** Linear-sRGB radiance of a blackbody at T (negative components of out-of-gamut reds clipped). */
export function blackbodyRgb(T: number): [number, number, number] {
  return xyzToLinearSrgb(blackbodyXYZ(T)).map((v) => Math.max(v, 0)) as [number, number, number];
}
