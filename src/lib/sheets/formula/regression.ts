// Least squares as Excel's LINEST computes it (R337), for LINEST, LOGEST,
// TREND and GROWTH: Excel evaluates the last three through LINEST.
//
// The x columns are centred when there is a constant, which is the same as
// fitting the column of ones LINEST "effectively inserts" first, then made
// orthonormal one at a time, left to right (Gram-Schmidt, each column taken
// twice so the rounding of the first pass is removed). A column that the
// earlier ones (and the constant) already span is left out of the model, as
// LINEST's page says: its coefficient and standard error are 0 and it adds 1
// to df. Which of the collinear columns goes is the page's "arbitrary"
// choice; Excel's own output in Microsoft's GROWTH article drops the later
// one (C = B + 1 beside B), and so does this.

/** A fit with LINEST's statistics. A value that cannot be computed is NaN or infinite. */
export type Fit = {
  /** m1…mk, in the order of the x columns; a column left out has 0. */
  m: number[];
  b: number;
  se: number[];
  seb: number;
  r2: number;
  sey: number;
  F: number;
  df: number;
  ssreg: number;
  ssresid: number;
};

/**
 * A column is left out when what the earlier ones cannot explain of it is
 * this small a part of it. Excel does not publish its tolerance; rounding in
 * this method leaves about 1e-16 of a collinear column, and data whose
 * columns are this close to collinear give coefficients that mean nothing.
 */
const COLLINEAR = 1e-10;

const dot = (a: number[], b: number[]) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** The fit of y on the columns xs, each as long as y; with a constant b unless `withConst` is false. */
export function leastSquares(y: number[], xs: number[][], withConst: boolean): Fit {
  const n = y.length;
  const k = xs.length;
  const meanOf = (v: number[]) => (withConst ? v.reduce((a, b) => a + b, 0) / n : 0);
  const ym = meanOf(y);
  const yc = y.map((v) => v - ym);
  const xm = xs.map(meanOf);
  const q: number[][] = [];
  // R by columns: the kept column j is rc[j][i]·q[i] summed over i ≤ j.
  const rc: number[][] = [];
  const kept: number[] = [];
  for (let j = 0; j < k; j++) {
    const v = xs[j].map((x) => x - xm[j]);
    const whole = Math.sqrt(dot(v, v));
    const along = Array<number>(q.length).fill(0);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < q.length; i++) {
        const d = dot(q[i], v);
        along[i] += d;
        for (let t = 0; t < n; t++) v[t] -= d * q[i][t];
      }
    }
    const left = Math.sqrt(dot(v, v));
    if (whole === 0 || left <= COLLINEAR * whole) continue;
    q.push(v.map((x) => x / left));
    rc.push([...along, left]);
    kept.push(j);
  }
  const p = kept.length;
  const qy = q.map((col) => dot(col, yc));
  // R β = Qᵀy, from the bottom up.
  const beta = Array<number>(p).fill(0);
  for (let i = p - 1; i >= 0; i--) {
    let s = qy[i];
    for (let j = i + 1; j < p; j++) s -= rc[j][i] * beta[j];
    beta[i] = s / rc[i][i];
  }
  // R⁻¹, upper triangular: (XᵀX)⁻¹ = R⁻¹R⁻ᵀ.
  const inv: number[][] = Array.from({ length: p }, () => Array<number>(p).fill(0));
  for (let j = 0; j < p; j++) {
    inv[j][j] = 1 / rc[j][j];
    for (let i = j - 1; i >= 0; i--) {
      let s = 0;
      for (let l = i + 1; l <= j; l++) s += rc[l][i] * inv[l][j];
      inv[i][j] = -s / rc[i][i];
    }
  }
  const resid = yc.slice();
  for (let i = 0; i < p; i++) for (let t = 0; t < n; t++) resid[t] -= qy[i] * q[i][t];
  const ssresid = dot(resid, resid);
  const sstotal = dot(yc, yc);
  const ssreg = sstotal - ssresid;
  const df = n - p - (withConst ? 1 : 0);
  const s2 = ssresid / df;
  const m = Array<number>(k).fill(0);
  const se = Array<number>(k).fill(0);
  kept.forEach((j, i) => {
    m[j] = beta[i];
    let d = 0;
    for (let l = i; l < p; l++) d += inv[i][l] ** 2;
    se[j] = Math.sqrt(s2 * d);
  });
  let b = 0;
  let seb = NaN;
  if (withConst) {
    b = ym - kept.reduce((a, j, i) => a + beta[i] * xm[j], 0);
    // var(b) = s²(1/n + x̄ᵀ(XcᵀXc)⁻¹x̄), and x̄ᵀR⁻¹R⁻ᵀx̄ = |R⁻ᵀx̄|².
    let quad = 0;
    for (let l = 0; l < p; l++) {
      let s = 0;
      for (let i = 0; i <= l; i++) s += inv[i][l] * xm[kept[i]];
      quad += s * s;
    }
    seb = Math.sqrt(s2 * (1 / n + quad));
  }
  return {
    m,
    b,
    se,
    seb,
    r2: ssreg / sstotal,
    sey: Math.sqrt(s2),
    F: ssreg / p / s2,
    df,
    ssreg,
    ssresid,
  };
}
