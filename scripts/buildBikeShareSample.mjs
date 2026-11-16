#!/usr/bin/env node
// Generates the "Bike Share Rides" sample (R501): a made-up city bike-share
// system laid over New York's geography, written as CSV for the lakehouse.
//
//   node scripts/buildBikeShareSample.mjs [outDir]     # default: ./bike-share-sample
//
// Everything is generated, from a fixed seed, so every run writes the same
// rows: no real trip records are used or redistributed, and no operator's
// name or brand appears. Stations are scattered over rough outlines of
// Manhattan, Brooklyn, Queens, the Bronx and Jersey City, densest in Midtown
// and Lower Manhattan; rides follow a weekly and a seasonal rhythm.
//
//   bike_stations      one row per station: id, name, area, latitude, longitude, docks
//   bike_station_days  one row per station, day and rider type: rides started
//                      and ended on electric and classic bikes, and minutes ridden
//
// To put them in the lakehouse: upload both in Data & SQL, then Lakehouse →
// Import dataset into a schema of your own (`bikeshare` in the BI docs'
// walkthrough, "Bike share rides from the lakehouse"), whose dashboard reads
// them there through the built-in Lakehouse connection.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outDir = path.resolve(process.argv[2] ?? "bike-share-sample");
const FIRST_DAY = Date.UTC(2025, 10, 1); // 1 November 2025
const DAYS = 365;

// ── A seeded generator: the same rows on every run ───────────────────────────
let seed = 0x5eed2026;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** Roughly normal, mean 0 and spread 1. */
const gauss = () => (rand() + rand() + rand() + rand() - 2) * 1.7;

// ── Rough land outlines, [longitude, latitude], drawn inside the shorelines ──
const AREAS = [
  {
    area: "Manhattan",
    stations: 210,
    pull: 1.6,
    ring: [
      [-74.0155, 40.7045],
      [-73.9995, 40.7095],
      [-73.9775, 40.7125],
      [-73.9745, 40.7275],
      [-73.9725, 40.7425],
      [-73.9615, 40.7585],
      [-73.9445, 40.7765],
      [-73.9335, 40.7945],
      [-73.9335, 40.8085],
      [-73.9355, 40.8345],
      [-73.9205, 40.8655],
      [-73.9295, 40.8725],
      [-73.9485, 40.8505],
      [-73.9605, 40.8225],
      [-73.9735, 40.7995],
      [-73.9905, 40.7715],
      [-74.0045, 40.7545],
      [-74.0115, 40.7305],
      [-74.0145, 40.7115],
    ],
  },
  {
    area: "Brooklyn",
    stations: 140,
    pull: 0.9,
    ring: [
      [-74.0125, 40.6745],
      [-73.9975, 40.6925],
      [-73.9895, 40.7015],
      [-73.9725, 40.7015],
      [-73.9625, 40.7135],
      [-73.9595, 40.7275],
      [-73.9445, 40.7285],
      [-73.9225, 40.7055],
      [-73.9185, 40.6775],
      [-73.9395, 40.6535],
      [-73.9685, 40.6445],
      [-73.9965, 40.6505],
    ],
  },
  {
    area: "Queens",
    stations: 50,
    pull: 0.7,
    ring: [
      [-73.9575, 40.7405],
      [-73.9465, 40.7575],
      [-73.9285, 40.7765],
      [-73.9075, 40.7705],
      [-73.9045, 40.7455],
      [-73.9285, 40.7365],
    ],
  },
  {
    area: "Bronx",
    stations: 30,
    pull: 0.5,
    ring: [
      [-73.9275, 40.8075],
      [-73.9285, 40.8365],
      [-73.9055, 40.8465],
      [-73.8845, 40.8215],
      [-73.9045, 40.8035],
    ],
  },
  {
    area: "Jersey City",
    stations: 50,
    pull: 0.6,
    ring: [
      [-74.0695, 40.7055],
      [-74.0365, 40.7125],
      [-74.0305, 40.7455],
      [-74.0335, 40.7555],
      [-74.0575, 40.7465],
      [-74.0735, 40.7225],
    ],
  },
];

function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// Busy cores: Midtown, Lower Manhattan, Downtown Brooklyn, Williamsburg.
const CORES = [
  [-73.9855, 40.7545, 1.0],
  [-74.0075, 40.7125, 0.8],
  [-73.9895, 40.6935, 0.5],
  [-73.9575, 40.7145, 0.5],
];
const busyness = ([x, y]) =>
  0.35 +
  CORES.reduce((s, [cx, cy, w]) => s + w * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 0.0006), 0);

const EAST_AVES = ["1 Ave", "2 Ave", "3 Ave", "Lexington Ave", "Park Ave", "Madison Ave"];
const WEST_AVES = [
  "6 Ave",
  "7 Ave",
  "8 Ave",
  "9 Ave",
  "10 Ave",
  "Broadway",
  "Amsterdam Ave",
  "Columbus Ave",
  "West End Ave",
];
const DOWNTOWN = [
  "Houston St",
  "Canal St",
  "Chambers St",
  "Fulton St",
  "Wall St",
  "Spring St",
  "Prince St",
  "Grand St",
  "Delancey St",
  "Rivington St",
  "Bleecker St",
  "Hudson St",
  "Greenwich St",
  "Lafayette St",
  "Bowery",
];
/** Fifth Avenue's longitude at a latitude: the line between east and west. */
const fifthAve = (lat) => -73.997 + (lat - 40.731) * 0.7186;
const STREETS = [
  "Atlantic",
  "Bedford",
  "Court",
  "Driggs",
  "Flatbush",
  "Franklin",
  "Fulton",
  "Grand",
  "Greenpoint",
  "Henry",
  "Kent",
  "Lafayette",
  "Myrtle",
  "Nassau",
  "Smith",
  "Union",
  "Vernon",
  "Wythe",
  "Steinway",
  "Ditmars",
  "Newark",
  "Grove",
  "Erie",
  "Montgomery",
  "Willis",
  "Alexander",
  "Morris",
  "Hoboken",
  "Pavonia",
  "Christopher",
];
const SUFFIX = ["St", "Ave", "Blvd", "Pl"];

const stations = [];
for (const a of AREAS) {
  const xs = a.ring.map((p) => p[0]);
  const ys = a.ring.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let made = 0;
  while (made < a.stations) {
    const p = [x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0)];
    if (!inside(p, a.ring)) continue;
    // Denser where it is busy: keep a point with probability by busyness.
    if (rand() > Math.min(1, busyness(p) / 1.2)) continue;
    made++;
    const id = `S${String(stations.length + 1).padStart(4, "0")}`;
    let name;
    if (a.area === "Manhattan") {
      const west = p[0] < fifthAve(p[1]);
      const aves = west ? WEST_AVES : EAST_AVES;
      const ave = aves[Math.floor(rand() * aves.length)];
      if (p[1] < 40.7295) {
        // Below 14 St the grid gives way to named streets.
        name = `${DOWNTOWN[Math.floor(rand() * DOWNTOWN.length)]} & ${ave}`;
      } else {
        const street = Math.max(14, Math.round((p[1] - 40.7295) * 1800));
        name = `${west ? "W" : "E"} ${street} St & ${ave}`;
      }
    } else {
      const s1 = STREETS[Math.floor(rand() * STREETS.length)];
      const s2 = STREETS[Math.floor(rand() * STREETS.length)];
      name = `${s1} ${SUFFIX[Math.floor(rand() * 2)]} & ${s2} ${SUFFIX[2 + Math.floor(rand() * 2)]}`;
    }
    stations.push({
      station_id: id,
      station_name: name,
      area: a.area,
      latitude: +p[1].toFixed(5),
      longitude: +p[0].toFixed(5),
      docks: 15 + Math.round(rand() * 40),
      pull: a.pull * busyness(p) * (0.6 + rand() * 0.8),
    });
  }
}

// ── Daily rides ───────────────────────────────────────────────────────────────
// Weekday rhythm (Sunday first): commuting days busiest, Sunday quietest.
const WEEKDAY = [0.82, 0.9, 0.95, 1.0, 1.02, 1.03, 0.97];
// Season: busiest late summer, quietest in January and February.
const season = (dayOfYear) =>
  0.62 +
  0.38 *
    Math.sin(((dayOfYear - 110) / 365) * 2 * Math.PI) ** 2 *
    (dayOfYear > 80 && dayOfYear < 320 ? 1 : 0.55);
const RIDERS = [
  { rider_type: "member", share: 0.79, minutes: 12.5, electric: 0.62 },
  { rider_type: "casual", share: 0.21, minutes: 21.0, electric: 0.71 },
];
// A pool of total pull, so a ride that starts somewhere ends somewhere.
const totalPull = stations.reduce((s, st) => s + st.pull, 0);
const BASE_RIDES_PER_DAY = 98000; // the whole system on an average day

const dayRows = [];
for (let d = 0; d < DAYS; d++) {
  const t = FIRST_DAY + d * 86400000;
  const date = new Date(t);
  const iso = date.toISOString().slice(0, 10);
  const doy = Math.floor((t - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  // Rain and cold days: a few quiet days scattered through the year.
  const weather = rand() < 0.08 ? 0.45 + rand() * 0.3 : 1;
  const dayTotal = BASE_RIDES_PER_DAY * WEEKDAY[date.getUTCDay()] * season(doy) * weather;
  for (const st of stations) {
    const share = st.pull / totalPull;
    for (const r of RIDERS) {
      const mean = dayTotal * share * r.share;
      const started = Math.max(0, Math.round(mean * (1 + 0.18 * gauss())));
      // Ends drift towards the busy cores in the morning and away at night:
      // over a day a station ends roughly what it starts, give or take.
      const ended = Math.max(0, Math.round(started * (1 + 0.12 * gauss())));
      const e = Math.min(1, Math.max(0, r.electric + 0.05 * gauss()));
      const startedElectric = Math.round(started * e);
      const endedElectric = Math.round(ended * e);
      dayRows.push([
        iso,
        st.station_id,
        r.rider_type,
        startedElectric,
        started - startedElectric,
        endedElectric,
        ended - endedElectric,
        Math.round(started * r.minutes * (1 + 0.1 * gauss())),
      ]);
    }
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
const csv = (header, rows) =>
  [
    header.join(","),
    ...rows.map((r) =>
      r.map((v) => (/[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(","),
    ),
  ].join("\n") + "\n";
writeFileSync(
  path.join(outDir, "bike_stations.csv"),
  csv(
    ["station_id", "station_name", "area", "latitude", "longitude", "docks"],
    stations.map((s) => [s.station_id, s.station_name, s.area, s.latitude, s.longitude, s.docks]),
  ),
);
writeFileSync(
  path.join(outDir, "bike_station_days.csv"),
  csv(
    [
      "ride_date",
      "station_id",
      "rider_type",
      "started_electric",
      "started_classic",
      "ended_electric",
      "ended_classic",
      "minutes",
    ],
    dayRows,
  ),
);
const rides = dayRows.reduce((s, r) => s + r[3] + r[4], 0);
console.log(
  `wrote ${outDir}: ${stations.length} stations, ${dayRows.length} station-days, ${rides.toLocaleString("en-US")} rides`,
);
