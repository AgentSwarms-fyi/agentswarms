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
