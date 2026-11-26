// What a forecast's known-ahead drivers were worth (R547), in one sentence.
//
// A driver is a number already planned for the periods ahead: a price, a
// promotion flag, a holiday count. The trainer backtests methods with and
// without the drivers and keeps whichever forecast the held-out periods
// better, so a driver that did not help is seen not to, rather than trusted
// because it was named. Pure, so the model page and a test agree.

export const MAX_FORECAST_DRIVERS = 10;

export type DriversEffect = { with: number | null; without: number | null; used: boolean };

export type DriversMeta = {
  drivers?: string[] | null;
  drivers_effect?: DriversEffect | null;
  /** Periods ahead that had no planned value, so the last known one was assumed. */
  drivers_assumed?: number | null;
  /** No period ahead had a planned value, so the drivers were not used. */
  drivers_unplanned?: boolean | null;
};

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** The sentence under a forecast, or null when it names no drivers. */
export function driversLine(meta: DriversMeta | null | undefined): string | null {
  const names = (meta?.drivers ?? []).filter(Boolean);
  if (!names.length) return null;
  const list = names.join(", ");
  // FOUND FROM THE UI (R547): with nothing planned, the drivers won a backtest
  // they had the actual values for, and the forecast then leaned on a guess.
  if (meta?.drivers_unplanned) {
    const n = meta.drivers_assumed ?? 0;
    return `Known ahead: ${list}. None of the ${n ? `${n} ` : ""}periods ahead had a planned value, so the forecast does not use them: put the planned values in rows past the last actual, with the target empty.`;
  }
  const e = meta?.drivers_effect ?? null;
  let line: string;
  if (e && e.with !== null && e.without !== null) {
    line = e.used
      ? `Known ahead: ${list}. With them the backtest error (RMSE) was ${fmt(e.with)}, against ${fmt(e.without)} without, so the forecast uses them.`
      : `Known ahead: ${list}. They did not help: the backtest error (RMSE) was ${fmt(e.with)} with them against ${fmt(e.without)} without, so the forecast does not use them.`;
  } else if (e && e.with === null) {
    line = `Known ahead: ${list}. No method could use them on this history, so the forecast does not.`;
  } else {
    line = `Known ahead: ${list}.`;
  }
  const assumed = meta?.drivers_assumed ?? 0;
  if (assumed > 0) {
    line += ` ${assumed} period${assumed === 1 ? "" : "s"} ahead had no planned value, and the last known one was assumed.`;
  }
  return line;
}

/**
 * Why a forecast's drivers cannot be saved, or null. A driver is a number
 * column that is not already the time, the target or the series.
 */
export function invalidDrivers(
  drivers: string[],
  taken: { time?: string | null; target?: string | null; series?: string | null },
): string | null {
  if (drivers.length > MAX_FORECAST_DRIVERS) {
    return `At most ${MAX_FORECAST_DRIVERS} known-ahead columns; ${drivers.length} were picked.`;
  }
  for (const d of drivers) {
    if (d === taken.time || d === taken.target || d === taken.series) {
      return `"${d}" is already the time, target or series column, so it cannot also be known ahead.`;
    }
  }
  if (new Set(drivers).size !== drivers.length) return "A column was picked twice.";
  return null;
}
