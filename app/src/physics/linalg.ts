/** An event or 4-vector, components ordered (t, x, y, z). Units: c = 1, so t means ct. */
export type Vec4 = [number, number, number, number];
/** A 4x4 matrix stored as rows: m[row][col]. */
export type Mat4 = number[][];
/** Christoffel symbols of the second kind, indexed Γ[μ][α][β] = Γ^μ_αβ. */
export type Christoffel = Mat4[];

export const ETA: Readonly<Mat4> = [
  [-1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

export function zeros4(): Mat4 {
  return [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
}

export function zeroChristoffel(): Christoffel {
  return [zeros4(), zeros4(), zeros4(), zeros4()];
}

/** g(u, v) = g_μν u^μ v^ν. */
export function inner(g: Mat4, u: ArrayLike<number>, v: ArrayLike<number>): number {
  let s = 0;
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) s += g[a][b] * u[a] * v[b];
  return s;
}

/** Inverse of a 4x4 matrix by Gauss–Jordan elimination with partial pivoting. */
export function inverse4(m: Mat4): Mat4 {
  const a = m.map((row, i) => [...row, ...[0, 1, 2, 3].map((j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-300) throw new Error('inverse4: singular matrix');
    [a[c], a[p]] = [a[p], a[c]];
    const inv = 1 / a[c][c];
    for (let j = 0; j < 8; j++) a[c][j] *= inv;
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f !== 0) for (let j = 0; j < 8; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(4));
}

/** Lower-triangular L with A = L Lᵀ for a small symmetric positive-definite A. */
export function cholesky(A: number[][]): number[][] {
  const n = A.length;
  const L = A.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) throw new Error('cholesky: matrix not positive definite');
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

/** Inverse of a lower-triangular matrix (forward substitution on the identity). */
export function invertLower(L: number[][]): number[][] {
  const n = L.length;
  const X = L.map(() => new Array<number>(n).fill(0));
  for (let col = 0; col < n; col++) {
    for (let i = 0; i < n; i++) {
      let s = i === col ? 1 : 0;
      for (let k = 0; k < i; k++) s -= L[i][k] * X[k][col];
      X[i][col] = s / L[i][i];
    }
  }
  return X;
}

/** Real roots of a·x² + b·x + c = 0 (degrades to the linear case when a ≈ 0). */
export function solveQuadratic(a: number, b: number, c: number): number[] {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return [];
  if (Math.abs(a) < 1e-12 * scale) return b === 0 ? [] : [-c / b];
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  // Numerically stable form: avoids cancellation between -b and √disc.
  const q = -0.5 * (b + Math.sign(b || 1) * Math.sqrt(disc));
  const roots = [q / a];
  if (q !== 0) roots.push(c / q);
  return roots;
}
