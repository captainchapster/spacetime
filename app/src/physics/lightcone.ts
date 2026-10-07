import { cholesky, invertLower, type Mat4 } from './linalg';

/**
 * Cross-section of the future light cone at an event, restricted to some spatial axes.
 *
 * A null displacement with dt = 1 and spatial part s satisfies
 *   g_tt + 2 b·s + sᵀ G s = 0,  with G = g_ij, b = g_ti over the chosen axes,
 * which is an ellipse (2 axes) or ellipsoid (3 axes): s = centre + basis · w for unit w.
 * In flat spacetime it's the unit circle/sphere; near a mass it shrinks (light is slower
 * in these coordinates) and shifts (the cone tilts toward the mass).
 */
export interface ConeSection {
  centre: number[];
  /** n × n matrix mapping the unit circle/sphere onto the section. */
  basis: number[][];
}

export function coneSection(g: Mat4, axes: number[]): ConeSection | null {
  const n = axes.length;
  const G = axes.map((i) => axes.map((j) => g[i][j]));
  const b = axes.map((i) => g[0][i]);
  let L: number[][];
  try {
    L = cholesky(G);
  } catch {
    return null;
  }
  const Li = invertLower(L);
  // G⁻¹ = L⁻ᵀ L⁻¹, so centre = −G⁻¹ b and R = bᵀ G⁻¹ b − g_tt.
  const y = Li.map((row) => row.reduce((s, v, k) => s + v * b[k], 0)); // L⁻¹ b
  const centre = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) centre[i] -= Li[k][i] * y[k];
  const R = y.reduce((s, v) => s + v * v, 0) - g[0][0];
  if (R <= 0) return null;
  const r = Math.sqrt(R);
  const basis = centre.map((_, i) => centre.map((__, j) => r * Li[j][i])); // √R · L⁻ᵀ
  return { centre, basis };
}
