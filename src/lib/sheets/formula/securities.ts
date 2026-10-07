// Excel's securities functions: the coupon schedule and the day counts its
// bond functions share (R335).
//
// Excel's pages give each function's equation and one example, not how a
// coupon date moves at a month's end or how 30/360 counts February. Those
// follow the analysis functions Excel shipped as an add-in, as LibreOffice
// reproduces them to match Excel's answers (its ScaDate), and YEARFRAC's
// bases follow Excel's own, as David A. Wheeler measured them. Every page's
// example is a test.

import { dateSerial, serialParts } from "./values";

/** 0 US 30/360, 1 actual/actual, 2 actual/360, 3 actual/365, 4 European 30/360. */
export type Basis = 0 | 1 | 2 | 3 | 4;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (m: number, y: number) =>
  [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/**
 * A date on a coupon schedule. A schedule from a month's last day stays on
 * last days, and under 30/360 no month has more than 30 days.
 */
class CouponDate {
  y: number;
  m: number;
  origDay: number;
  day = 0;
  lastDay: boolean;
  readonly thirty: boolean;
  readonly us: boolean;

  constructor(serial: number, basis: Basis) {
    const p = serialParts(serial);
    this.y = p.y;
    this.m = p.m;
    this.origDay = p.d;
    this.thirty = basis === 0 || basis === 4;
    this.us = basis === 0;
    this.lastDay = p.d >= daysIn(p.m, p.y);
    this.setDay();
  }

  clone(): CouponDate {
    return Object.assign(Object.create(CouponDate.prototype), this) as CouponDate;
  }

  private setDay() {
    if (this.thirty) {
      this.day = Math.min(this.origDay, 30);
      if (this.lastDay || this.day >= daysIn(this.m, this.y)) this.day = 30;
    } else {
      const last = daysIn(this.m, this.y);
      this.day = this.lastDay ? last : Math.min(this.origDay, last);
    }
  }

  addMonths(n: number) {
    const total = this.m - 1 + n;
    this.y += Math.floor(total / 12);
    this.m = (((total % 12) + 12) % 12) + 1;
    this.setDay();
  }

  setYear(y: number) {
    this.y = y;
    this.setDay();
  }

  /** The calendar date it stands for. */
  serial(): number {
    const last = daysIn(this.m, this.y);
    return dateSerial(this.y, this.m, this.lastDay ? last : Math.min(last, this.origDay));
  }

  before(o: CouponDate): boolean {
    if (this.y !== o.y) return this.y < o.y;
    if (this.m !== o.m) return this.m < o.m;
    if (this.day !== o.day) return this.day < o.day;
    if (this.lastDay || o.lastDay) return !this.lastDay && o.lastDay;
    return this.origDay < o.origDay;
  }

  private monthDays(): number {
    return this.thirty ? 30 : daysIn(this.m, this.y);
  }

  /** Days from this date to a later one, counted as the basis counts them. */
  static diff(from: CouponDate, to: CouponDate): number {
    if (to.before(from)) return CouponDate.diff(to, from);
    const a = from.clone();
    const b = to.clone();
    if (to.thirty) {
      if (to.us) {
        // US: a 31st after a day before the 30th, or a February, stays the 31st.
        if ((from.m === 2 || from.day < 30) && b.origDay === 31) b.day = 31;
        else if (b.m === 2 && b.lastDay) b.day = daysIn(2, b.y);
      } else {
        if (a.m === 2 && a.day === 30) a.day = daysIn(2, a.y);
        if (b.m === 2 && b.day === 30) b.day = daysIn(2, b.y);
      }
    }
    let n = 0;
    if (a.y < b.y || (a.y === b.y && a.m < b.m)) {
      // To the first of the next month, then whole months and years.
      n = a.monthDays() - a.day + 1;
      a.origDay = 1;
      a.day = 1;
      a.lastDay = false;
      a.addMonths(1);
      while (a.y < b.y || a.m < b.m) {
        n += a.monthDays();
        a.addMonths(1);
      }
    }
    n += b.day - a.day;
    return n > 0 ? n : 0;
  }
}

/** The coupon date on or before settlement (COUPPCD). */
function previousCoupon(settle: CouponDate, mat: CouponDate, freq: number): CouponDate {
  const d = mat.clone();
  d.setYear(settle.y);
  if (d.before(settle)) d.setYear(d.y + 1);
  while (settle.before(d)) d.addMonths(-12 / freq);
  return d;
}
/** The coupon date after settlement (COUPNCD). */
function nextCoupon(settle: CouponDate, mat: CouponDate, freq: number): CouponDate {
  const d = mat.clone();
  d.setYear(settle.y);
  if (settle.before(d)) d.setYear(d.y - 1);
  while (!settle.before(d)) d.addMonths(12 / freq);
  return d;
}

/** Days in a year by the basis; actual/actual counts the year of the date. */
export function daysInYear(serial: number, basis: Basis): number {
  if (basis === 3) return 365;
  if (basis === 1) return isLeap(serialParts(serial).y) ? 366 : 365;
  return 360;
}

export const couppcd = (settle: number, mat: number, freq: number, basis: Basis): number =>
  previousCoupon(new CouponDate(settle, basis), new CouponDate(mat, basis), freq).serial();

export const coupncd = (settle: number, mat: number, freq: number, basis: Basis): number =>
  nextCoupon(new CouponDate(settle, basis), new CouponDate(mat, basis), freq).serial();

export function coupnum(settle: number, mat: number, freq: number, basis: Basis): number {
  const m = new CouponDate(mat, basis);
  const pcd = previousCoupon(new CouponDate(settle, basis), m, freq);
  const months = (m.y - pcd.y) * 12 + m.m - pcd.m;
  return Math.trunc((months * freq) / 12);
}

export function coupdaybs(settle: number, mat: number, freq: number, basis: Basis): number {
  const s = new CouponDate(settle, basis);
  return CouponDate.diff(previousCoupon(s, new CouponDate(mat, basis), freq), s);
}

export function coupdays(settle: number, mat: number, freq: number, basis: Basis): number {
  if (basis !== 1) return (basis === 3 ? 365 : 360) / freq;
  const pcd = previousCoupon(new CouponDate(settle, basis), new CouponDate(mat, basis), freq);
  const next = pcd.clone();
  next.addMonths(12 / freq);
  return CouponDate.diff(pcd, next);
}

export function coupdaysnc(settle: number, mat: number, freq: number, basis: Basis): number {
  if (basis === 0 || basis === 4)
    return coupdays(settle, mat, freq, basis) - coupdaybs(settle, mat, freq, basis);
  const s = new CouponDate(settle, basis);
  return CouponDate.diff(s, nextCoupon(s, new CouponDate(mat, basis), freq));
}

/**
 * YEARFRAC's year fraction, as Excel counts it (Wheeler's measurement of
 * Excel): US 30/360 with its February rules, actual over 366 in a span
 * holding a February 29th and 365 otherwise, or over the average year for
 * a span of more than a year, actual/360, actual/365, European 30/360.
 */
export function yearFrac(start: number, end: number, basis: Basis): number {
  let a = Math.trunc(start);
  let b = Math.trunc(end);
  if (a === b) return 0;
  if (a > b) [a, b] = [b, a];
  const p = serialParts(a);
  const q = serialParts(b);
  if (basis === 2) return (b - a) / 360;
  if (basis === 3) return (b - a) / 365;
  if (basis === 0 || basis === 4) {
    let d1 = p.d;
    let d2 = q.d;
    if (basis === 4) {
      if (d1 === 31) d1 = 30;
      if (d2 === 31) d2 = 30;
    } else {
      const last1 = p.d === daysIn(p.m, p.y);
      const last2 = q.d === daysIn(q.m, q.y);
      if (d1 === 31 && d2 === 31) {
        d1 = 30;
        d2 = 30;
      } else if (d1 === 31) d1 = 30;
      else if (d1 === 30 && d2 === 31) d2 = 30;
      else if (p.m === 2 && q.m === 2 && last1 && last2) {
        d1 = 30;
        d2 = 30;
      } else if (p.m === 2 && last1) d1 = 30;
    }
    return (d2 + q.m * 30 + q.y * 360 - (d1 + p.m * 30 + p.y * 360)) / 360;
  }
  // Actual/actual.
  const withinAYear =
    p.y === q.y || (q.y === p.y + 1 && (p.m > q.m || (p.m === q.m && p.d >= q.d)));
  if (withinAYear) {
    let year = 365;
    if (p.y === q.y && isLeap(p.y)) year = 366;
    else {
      for (const y of [p.y, q.y]) {
        const feb29 = isLeap(y) ? dateSerial(y, 2, 29) : NaN;
        if (feb29 >= a && feb29 <= b) year = 366;
      }
    }
    return (b - a) / year;
  }
  const years = q.y - p.y + 1;
  const days = dateSerial(q.y + 1, 1, 1) - dateSerial(p.y, 1, 1);
  return (b - a) / (days / years);
}

/** Truncate dates, check the frequency and basis: Excel's rules on every one of these pages. */
export function checkBasis(b: number): Basis | null {
  const t = Number.isNaN(b) ? 0 : Math.trunc(b);
  return t >= 0 && t <= 4 ? (t as Basis) : null;
}
export function checkFrequency(f: number): number | null {
  const t = Math.trunc(f);
  return t === 1 || t === 2 || t === 4 ? t : null;
}

/** DOLLARDE and DOLLARFR's decimal digits for a fraction: 16 is read as hundredths. */
const digitsFor = (f: number) => 10 ** Math.ceil(Math.log10(f));
export const dollarde = (x: number, f: number): number => {
  const whole = Math.trunc(x);
  return whole + ((x - whole) * digitsFor(f)) / f;
};
export const dollarfr = (x: number, f: number): number => {
  const whole = Math.trunc(x);
  return whole + ((x - whole) * f) / digitsFor(f);
};

// ── Prices, yields, durations, accrued interest, odd periods (R336) ──────────
//
// Each from its page's equation, checked first in Python against the pages'
// examples. One choice the pages settle: DURATION times each cash flow from
// DSC/E, the days to the next coupon over the period's; LibreOffice's form,
// built on YEARFRAC, gives 10.92157 for the page's 10.9191453.

/** A bond's coupon facts at settlement: N coupons left, E days in the period, A accrued, DSC to the next. */
function facts(s: number, m: number, f: number, b: Basis) {
  return {
    n: coupnum(s, m, f, b),
    e: coupdays(s, m, f, b),
    a: coupdaybs(s, m, f, b),
    dsc: coupdaysnc(s, m, f, b),
  };
}

/** PRICE(settlement, maturity, rate, yld, redemption, frequency, basis) per $100. */
export function price(
  s: number,
  m: number,
  rate: number,
  yld: number,
  red: number,
  f: number,
  b: Basis,
): number {
  const { n, e, a, dsc } = facts(s, m, f, b);
  const c = (100 * rate) / f;
  if (n === 1) return (c + red) / ((yld / f) * ((e - a) / e) + 1) - (c * a) / e;
  const y = 1 + yld / f;
  const t0 = dsc / e;
  let p = red / y ** (n - 1 + t0);
  for (let k = 1; k <= n; k++) p += c / y ** (k - 1 + t0);
  return p - (c * a) / e;
}

/**
 * The rate at which a price function, falling as the rate rises, gives a
 * target: by bisection to the last digit, from just above −f (where the
 * discount factor would vanish) up to where the price falls below it.
 * Null when no rate up to 10^6 does.
 */
export function solveRate(
  priceAt: (y: number) => number,
  target: number,
  f: number,
): number | null {
  let lo = -f * (1 - 1e-12);
  let hi = 1;
  while (priceAt(hi) > target) {
    hi *= 2;
    if (hi > 1e6) return null;
  }
  if (!(priceAt(lo) >= target)) return null;
  for (let i = 0; i < 400; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (priceAt(mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** YIELD: the page's closed form for one period or less to redemption, else PRICE solved for it. */
export function yieldOf(
  s: number,
  m: number,
  rate: number,
  pr: number,
  red: number,
  f: number,
  b: Basis,
): number | null {
  const { n, e, a } = facts(s, m, f, b);
  if (n <= 1) {
    const paid = pr / 100 + (a / e) * (rate / f);
    return ((red / 100 + rate / f - paid) / paid) * ((f * e) / (e - a));
  }
  return solveRate((y) => price(s, m, rate, y, red, f, b), pr, f);
}

/** DURATION: Macaulay's, each cash flow timed DSC/E periods past the last coupon. */
export function duration(
  s: number,
  m: number,
  coupon: number,
  yld: number,
  f: number,
  b: Basis,
): number {
  const { n, e, dsc } = facts(s, m, f, b);
  const c = (coupon * 100) / f;
  const y = 1 + yld / f;
  let pv = 0;
  let timed = 0;
  for (let k = 1; k <= n; k++) {
    const t = k - 1 + dsc / e;
    const v = (k === n ? c + 100 : c) / y ** t;
    pv += v;
    timed += t * v;
  }
  return timed / pv / f;
}

/** The normal length in days of a coupon period on the basis. */
function periodLength(from: CouponDate, to: CouponDate, f: number, b: Basis): number {
  if (b === 1) return CouponDate.diff(from, to);
  return (b === 3 ? 365 : 360) / f;
}
/** Days from one date to another as the basis counts them. */
function daysOn(a: number, b2: number, b: Basis): number {
  if (b === 2 || b === 3 || b === 1) return Math.max(0, b2 - a);
  return CouponDate.diff(new CouponDate(a, b), new CouponDate(b2, b));
}

/**
 * Quasi-coupon periods on a schedule anchored at `anchor`, stepping back
 * from it (or on from it) until they cover [from, to]: each with its start,
 * end and normal length.
 */
function quasiPeriods(anchor: number, from: number, to: number, f: number, b: Basis) {
  const step = 12 / f;
  const at = (j: number) => {
    const d = new CouponDate(anchor, b);
    d.addMonths(j * step);
    return d;
  };
  let j = 0;
  while (at(j).serial() > from) j--;
  const out: { start: number; end: number; length: number }[] = [];
  for (; at(j).serial() < to; j++) {
    const s0 = at(j);
    const s1 = at(j + 1);
    out.push({ start: s0.serial(), end: s1.serial(), length: periodLength(s0, s1, f, b) });
  }
  return out;
}
/** Σ (days of [from, to] in each quasi period) / its normal length. */
function periodsIn(
  periods: { start: number; end: number; length: number }[],
  from: number,
  to: number,
  b: Basis,
): number {
  let sum = 0;
  for (const p of periods) {
    const a = Math.max(from, p.start);
    const z = Math.min(to, p.end);
    if (z > a) sum += daysOn(a, z, b) / p.length;
  }
  return sum;
}

/**
 * ACCRINT: par × rate/frequency × Σ A_i/NL_i over the quasi-coupon periods
 * on first_interest's schedule, from issue (or, with calc_method FALSE and
 * settlement past the first interest date, from the coupon date before
 * settlement) to settlement.
 */
export function accrint(
  issue: number,
  first: number,
  s: number,
  rate: number,
  par: number,
  f: number,
  b: Basis,
  fromIssue: boolean,
): number {
  let start = issue;
  if (!fromIssue && s > first) {
    const periods = quasiPeriods(first, first, s, f, b);
    start = Math.max(issue, ...periods.filter((p) => p.start <= s).map((p) => p.start));
  }
  const periods = quasiPeriods(first, Math.min(start, first), s, f, b);
  return ((par * rate) / f) * periodsIn(periods, start, s, b);
}

/**
 * ODDFPRICE: the page's equation for an odd first period, short or long. With
 * one quasi period before the first coupon it is the page's short-coupon form.
 */
export function oddfprice(
  s: number,
  m: number,
  issue: number,
  first: number,
  rate: number,
  yld: number,
  red: number,
  f: number,
  b: Basis,
): number {
  const before = quasiPeriods(first, issue, first, f, b);
  const c = (100 * rate) / f;
  const y = 1 + yld / f;
  // The quasi period holding settlement, and the whole ones after it to the first coupon.
  const i = before.findIndex((p) => s >= p.start && s < p.end);
  const here = before[i];
  const e = here.length;
  const dsc = daysOn(s, here.end, b);
  const nq = before.length - 1 - i;
  const regular = coupnum(first, m, f, b);
  const t0 = nq + dsc / e;
  let p = red / y ** (regular + t0);
  p += (c * periodsIn(before, issue, first, b)) / y ** t0;
  for (let k = 1; k <= regular; k++) p += c / y ** (k + t0);
  return p - c * periodsIn(before, issue, s, b);
}

/** ODDLPRICE and ODDLYIELD's three sums over the quasi periods from the last interest date. */
function oddLast(s: number, m: number, last: number, f: number, b: Basis) {
  const periods = quasiPeriods(last, last, m, f, b);
  return {
    dc: periodsIn(periods, last, m, b),
    a: periodsIn(periods, last, s, b),
    dsc: periodsIn(periods, s, m, b),
  };
}
export function oddlprice(
  s: number,
  m: number,
  last: number,
  rate: number,
  yld: number,
  red: number,
  f: number,
  b: Basis,
): number {
  const { dc, a, dsc } = oddLast(s, m, last, f, b);
  const c = (100 * rate) / f;
  return (red + dc * c) / (1 + (dsc * yld) / f) - a * c;
}
export function oddlyield(
  s: number,
  m: number,
  last: number,
  rate: number,
  pr: number,
  red: number,
  f: number,
  b: Basis,
): number {
  const { dc, a, dsc } = oddLast(s, m, last, f, b);
  const c = (100 * rate) / f;
  const paid = pr + a * c;
  return ((red + dc * c - paid) / paid) * (f / dsc);
}

/**
 * AMORDEGRC: the French declining depreciation. The rate is multiplied by
 * 1.5, 2 or 2.5 by the life (1/rate); the first period is prorated over its
 * year fraction; each period's amount is rounded to a whole number; and the
 * period before the last takes half of what is left, the last the rest.
 * Null for a life the page refuses (under 3 years, or between 4 and 5).
 */
export function amordegrc(
  cost: number,
  bought: number,
  first: number,
  salvage: number,
  period: number,
  rate: number,
  b: Basis,
): number | null {
  const life = 1 / rate;
  const coeff = life >= 3 && life <= 4 ? 1.5 : life >= 5 && life <= 6 ? 2 : life > 6 ? 2.5 : null;
  if (coeff === null) return null;
  const r = rate * coeff;
  const round = (x: number) => Math.sign(x) * Math.floor(Math.abs(x) + 0.5 + 1e-9);
  let amount = round(yearFrac(bought, first, b) * r * cost);
  if (period === 0) return amount;
  let left = cost - amount;
  let rest = left - salvage;
  for (let n = 0; n < period; n++) {
    amount = round(r * left);
    rest -= amount;
    if (rest < 0) return period - n <= 1 ? round(left * 0.5) : 0;
    left -= amount;
  }
  return amount;
}

/** AMORLINC: straight-line French depreciation, the first period prorated, the last what is left. */
export function amorlinc(
  cost: number,
  bought: number,
  first: number,
  salvage: number,
  period: number,
  rate: number,
  b: Basis,
): number {
  const one = cost * rate;
  const first0 = yearFrac(bought, first, b) * rate * cost;
  const full = Math.trunc((cost - salvage - first0) / one);
  if (period === 0) return first0;
  if (period <= full) return one;
  if (period === full + 1) return cost - salvage - one * full - first0;
  return 0;
}
