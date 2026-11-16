#!/usr/bin/env node
// Builds the "Grand Prix" sample datasets (R500) from the public Jolpica F1
// API — the successor of the Ergast Motor Racing Data API. The data is
// CC BY-NC-SA 4.0 (see ACKNOWLEDGEMENTS.md): the gp_*.csv files stay under that
// licence, not the repository's.
//
//   node scripts/buildGrandPrixSample.mjs            # the latest race
//   node scripts/buildGrandPrixSample.mjs 2026 20    # a given season/round
//
// Writes src/assets/sample-data/gp_*.csv:
//   gp_race_results        one row per driver in the race: grid, finish, gap,
//                          points, fastest lap, positions gained, badges
//   gp_race_laps           one row per driver per lap: position and lap time
//   gp_race_pitstops       one row per pit stop
//   gp_season_points       one row per driver per round: race + sprint points
//   gp_driver_standings    the championship after the race
//   gp_constructor_standings
//   gp_schedule            every round of the season, completed or upcoming
//
// No photos or logos: driver and team badges, and flags, are drawn here as
// small SVGs (team colours and national flags are facts, not artwork).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.jolpi.ca/ergast/f1";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "assets", "sample-data");
const UA = { "User-Agent": "agentswarms-sample-builder" };

// The API asks for at most 4 requests a second.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let attempt = 1; ; attempt++) {
    await sleep(400);
    const res = await fetch(`${API}/${path}`, { headers: UA });
    if (res.ok) return (await res.json()).MRData;
    if (attempt >= 4) throw new Error(`${path}: HTTP ${res.status}`);
    await sleep(2000 * attempt);
  }
}
/** Every page of a paginated endpoint; `pick` returns the page's items. */
async function getAll(path, pick) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const sep = path.includes("?") ? "&" : "?";
    const d = await get(`${path}${sep}limit=100&offset=${offset}`);
    out.push(...pick(d));
    if (offset + 100 >= Number(d.total)) return out;
  }
}

// ── Colours, badges and flags ────────────────────────────────────────────────

const TEAM_COLOR = {
  mercedes: "#27F4D2",
  ferrari: "#E8002D",
  red_bull: "#3671C6",
  mclaren: "#FF8000",
  rb: "#6692FF",
  alpine: "#FF87BC",
  haas: "#B6BABD",
  audi: "#8A1538",
  sauber: "#52E252",
  williams: "#64C4FF",
  aston_martin: "#229971",
  cadillac: "#D4AF37",
};
const teamColor = (id) => TEAM_COLOR[id] ?? "#9CA3AF";

/** Black or white, whichever reads on the colour. */
function ink(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#111111" : "#FFFFFF";
}
const svgUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/** A driver's card: number and code on the team colour. */
function driverBadge(number, code, color) {
  const fg = ink(color);
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="18" fill="${color}"/>` +
      `<text x="60" y="66" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="900" font-size="54" fill="${fg}">${number}</text>` +
      `<text x="60" y="100" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="22" letter-spacing="3" fill="${fg}">${code}</text></svg>`,
  );
}

/** A team's mark: its initials in a disc of its colour. */
function teamBadge(name, color) {
  const initials = name
    .replace(/\b(F1|Team)\b/g, "")
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="${color}"/>` +
      `<text x="32" y="40" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="900" font-size="${initials.length > 2 ? 18 : 22}" fill="${ink(color)}">${initials}</text></svg>`,
  );
}

const h3 = (a, b, c) =>
  `<rect width="30" height="20" fill="${a}"/><rect y="6.67" width="30" height="6.67" fill="${b}"/><rect y="13.33" width="30" height="6.67" fill="${c}"/>`;
const v3 = (a, b, c) =>
  `<rect width="10" height="20" fill="${a}"/><rect x="10" width="10" height="20" fill="${b}"/><rect x="20" width="10" height="20" fill="${c}"/>`;
const UNION =
  `<rect width="30" height="20" fill="#012169"/><path d="M0 0L30 20M30 0L0 20" stroke="#fff" stroke-width="4"/>` +
  `<path d="M0 0L30 20M30 0L0 20" stroke="#C8102E" stroke-width="1.6"/><path d="M15 0V20M0 10H30" stroke="#fff" stroke-width="6"/>` +
  `<path d="M15 0V20M0 10H30" stroke="#C8102E" stroke-width="3.4"/>`;
const canton = `<svg x="0" y="0" width="15" height="10" viewBox="0 0 30 20">${UNION}</svg>`;
const stars = (fill, pts) =>
  pts.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`).join("");

// Simplified national flags (public-domain designs), 3:2.
const FLAG = {
  British: UNION,
  Dutch: h3("#AE1C28", "#FFFFFF", "#21468B"),
  French: v3("#002654", "#FFFFFF", "#CE1126"),
  Italian: v3("#009246", "#FFFFFF", "#CE2B37"),
  German: h3("#000000", "#DD0000", "#FFCE00"),
  Monegasque: `<rect width="30" height="10" fill="#CE1126"/><rect y="10" width="30" height="10" fill="#FFFFFF"/>`,
  Spanish: `<rect width="30" height="20" fill="#AA151B"/><rect y="5" width="30" height="10" fill="#F1BF00"/>`,
  Thai: `<rect width="30" height="20" fill="#A51931"/><rect y="3.33" width="30" height="13.33" fill="#F4F5F8"/><rect y="6.67" width="30" height="6.67" fill="#2D2A4A"/>`,
  Japanese: `<rect width="30" height="20" fill="#FFFFFF"/><circle cx="15" cy="10" r="6" fill="#BC002D"/>`,
  Finnish: `<rect width="30" height="20" fill="#FFFFFF"/><rect x="8" width="5" height="20" fill="#002F6C"/><rect y="7.5" width="30" height="5" fill="#002F6C"/>`,
  Canadian: `<rect width="30" height="20" fill="#FFFFFF"/><rect width="7.5" height="20" fill="#D52B1E"/><rect x="22.5" width="7.5" height="20" fill="#D52B1E"/><path d="M15 4l1.6 3.4 2.4-1-1 4.6 2-1.4.6 1.6-2.6 2.6.4 1.2H15.6V17h-1.2v-2H11.6l.4-1.2-2.6-2.6.6-1.6 2 1.4-1-4.6 2.4 1z" fill="#D52B1E"/>`,
  Argentine: `${h3("#74ACDF", "#FFFFFF", "#74ACDF")}<circle cx="15" cy="10" r="2.2" fill="#F6B40E"/>`,
  Brazilian: `<rect width="30" height="20" fill="#009C3B"/><path d="M15 2.5L27.5 10 15 17.5 2.5 10z" fill="#FFDF00"/><circle cx="15" cy="10" r="4.4" fill="#002776"/>`,
  Mexican: `${v3("#006847", "#FFFFFF", "#CE1126")}<circle cx="15" cy="10" r="2.2" fill="#8C5A2B"/>`,
  Australian: `<rect width="30" height="20" fill="#012169"/>${canton}${stars("#FFFFFF", [
    [7.5, 15, 1.8],
    [22.5, 4, 0.9],
    [19, 9, 0.9],
    [25.5, 8.5, 0.9],
    [22.5, 16, 0.9],
    [24.5, 12, 0.5],
  ])}`,
  "New Zealander": `<rect width="30" height="20" fill="#012169"/>${canton}${stars("#C8102E", [
    [22.5, 4.5, 0.9],
    [19.5, 9, 0.8],
    [25.5, 8.5, 0.8],
    [22.5, 16, 1],
  ])}`,
};
function flag(nationality) {
  const body = FLAG[nationality];
  if (!body) return "";
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20" width="30" height="20">${body}<rect width="30" height="20" fill="none" stroke="#00000033"/></svg>`,
  );
}

// ── CSV ──────────────────────────────────────────────────────────────────────

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(name, rows) {
  const cols = Object.keys(rows[0]);
  const text = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join(
    "\n",
  );
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.csv`), `${text}\n`);
  console.log(`  ${name}.csv  ${rows.length} rows`);
}

/** "1:12.983" or "72.983" → seconds. */
function seconds(t) {
  if (!t) return null;
  const parts = String(t).split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// ── Build ────────────────────────────────────────────────────────────────────

const [argSeason, argRound] = process.argv.slice(2);
const racePath = argSeason && argRound ? `${argSeason}/${argRound}` : "current/last";
const raceData = await get(`${racePath}/results.json`);
const race = raceData.RaceTable.Races[0];
const season = race.season;
const round = Number(race.round);
console.log(`${season} round ${round}: ${race.raceName} (${race.date})`);

const results = race.Results;
const byDriver = new Map(results.map((r) => [r.Driver.driverId, r]));
const finishOf = (id) => Number(byDriver.get(id)?.position);

writeCsv(
  "gp_race_results",
  results.map((r) => {
    const color = teamColor(r.Constructor.constructorId);
    const grid = Number(r.grid);
    const finish = Number(r.position);
    const finished = /^\d+$/.test(r.positionText);
    // Grid 0 is a pit-lane start: behind everyone who took the grid.
    const start = grid > 0 ? grid : results.length;
    return {
      season,
      round,
      race: race.raceName,
      circuit: race.Circuit.circuitName,
      locality: race.Circuit.Location.locality,
      country: race.Circuit.Location.country,
      race_date: race.date,
      finish_position: finish,
      // Text, never a number: "P1" … "DNF". A column of mostly numbers is
      // loaded as numbers, and "DNF" would become empty.
      position_text: finished ? `P${r.positionText}` : "DNF",
      grid: start,
      grid_text: grid > 0 ? `P${grid}` : "Pit lane",
      driver: `${r.Driver.givenName} ${r.Driver.familyName}`,
      given_name: r.Driver.givenName,
      family_name: r.Driver.familyName,
      code: r.Driver.code,
      number: r.number,
      nationality: r.Driver.nationality,
      team: r.Constructor.name,
      team_color: color,
      // The winner's time, others' gap with its unit ("+14.602s"), else the
      // status ("+1 Lap", "Retired"). "+14.602" alone would load as the
      // number 14.602, and the winner's "1:35:23.504" as nothing.
      race_time: r.Time?.time
        ? r.Time.time.startsWith("+")
          ? `${r.Time.time}s`
          : r.Time.time
        : r.status,
      status: r.status,
      points: Number(r.points),
      laps: Number(r.laps),
      fastest_lap_rank: r.FastestLap ? Number(r.FastestLap.rank) : null,
      fastest_lap_time: r.FastestLap?.Time?.time ?? "",
      fastest_lap_number: r.FastestLap ? Number(r.FastestLap.lap) : null,
      positions_gained: finished ? start - finish : null,
      badge: driverBadge(r.number, r.Driver.code, color),
      flag: flag(r.Driver.nationality),
    };
  }),
);

const laps = await getAll(`${season}/${round}/laps.json`, (d) => d.RaceTable.Races[0]?.Laps ?? []);
// Pages split a lap's timings; merge them by lap number.
const lapRows = [];
for (const lap of laps) {
  for (const t of lap.Timings) {
    const r = results.find((x) => x.Driver.driverId === t.driverId);
    if (!r) continue;
    lapRows.push({
      lap: Number(lap.number),
      code: r.Driver.code,
      family_name: r.Driver.familyName,
      team: r.Constructor.name,
      team_color: teamColor(r.Constructor.constructorId),
      position: Number(t.position),
      lap_time: t.time,
      lap_seconds: seconds(t.time),
      final_position: finishOf(t.driverId),
    });
  }
}
lapRows.sort((a, b) => a.lap - b.lap || a.position - b.position);
writeCsv("gp_race_laps", lapRows);

const stops = await getAll(
  `${season}/${round}/pitstops.json`,
  (d) => d.RaceTable.Races[0]?.PitStops ?? [],
);
writeCsv(
  "gp_race_pitstops",
  stops.map((s) => {
    const r = byDriver.get(s.driverId);
    return {
      code: r?.Driver.code ?? s.driverId,
      family_name: r?.Driver.familyName ?? s.driverId,
      team: r?.Constructor.name ?? "",
      stop: Number(s.stop),
      lap: Number(s.lap),
      duration_s: Number(s.duration) || null,
    };
  }),
);

const seasonRaces = await getAll(`${season}/results.json`, (d) => d.RaceTable.Races);
const seasonSprints = await getAll(`${season}/sprint.json`, (d) => d.RaceTable.Races);
const points = new Map(); // `${round}|${driverId}` → row
function addPoints(r, res, key) {
  const k = `${r.round}|${res.Driver.driverId}`;
  const row = points.get(k) ?? {
    round: Number(r.round),
    race: r.raceName,
    race_date: r.date,
    code: res.Driver.code,
    driver: `${res.Driver.givenName} ${res.Driver.familyName}`,
    family_name: res.Driver.familyName,
    team: res.Constructor.name,
    team_color: teamColor(res.Constructor.constructorId),
    race_points: 0,
    sprint_points: 0,
    points: 0,
  };
  row[key] += Number(res.points);
  row.points = row.race_points + row.sprint_points;
  points.set(k, row);
}
for (const r of seasonRaces) {
  if (Number(r.round) > round) continue;
  for (const res of r.Results ?? []) addPoints(r, res, "race_points");
}
for (const r of seasonSprints) {
  if (Number(r.round) > round) continue;
  for (const res of r.SprintResults ?? []) addPoints(r, res, "sprint_points");
}
writeCsv(
  "gp_season_points",
  [...points.values()].sort((a, b) => a.round - b.round || b.points - a.points),
);

const ds = (await get(`${season}/${round}/driverStandings.json`)).StandingsTable.StandingsLists[0];
writeCsv(
  "gp_driver_standings",
  ds.DriverStandings.map((s) => {
    const team = s.Constructors[s.Constructors.length - 1];
    const color = teamColor(team.constructorId);
    return {
      position: Number(s.position),
      driver: `${s.Driver.givenName} ${s.Driver.familyName}`,
      given_name: s.Driver.givenName,
      family_name: s.Driver.familyName,
      code: s.Driver.code,
      number: s.Driver.permanentNumber ?? "",
      nationality: s.Driver.nationality,
      team: team.name,
      team_color: color,
      points: Number(s.points),
      wins: Number(s.wins),
      badge: driverBadge(s.Driver.permanentNumber ?? "", s.Driver.code, color),
      flag: flag(s.Driver.nationality),
    };
  }),
);

const cs = (await get(`${season}/${round}/constructorStandings.json`)).StandingsTable
  .StandingsLists[0];
writeCsv(
  "gp_constructor_standings",
  cs.ConstructorStandings.map((s) => {
    const color = teamColor(s.Constructor.constructorId);
    return {
      position: Number(s.position),
      team: s.Constructor.name,
      nationality: s.Constructor.nationality,
      team_color: color,
      points: Number(s.points),
      wins: Number(s.wins),
      badge: teamBadge(s.Constructor.name, color),
    };
  }),
);

const schedule = (await get(`${season}.json`)).RaceTable.Races;
writeCsv(
  "gp_schedule",
  schedule.map((r) => ({
    round: Number(r.round),
    race: r.raceName,
    circuit: r.Circuit.circuitName,
    locality: r.Circuit.Location.locality,
    country: r.Circuit.Location.country,
    race_date: r.date,
    sprint: r.Sprint ? "yes" : "no",
    status: Number(r.round) <= round ? "completed" : "upcoming",
  })),
);
console.log("done");
