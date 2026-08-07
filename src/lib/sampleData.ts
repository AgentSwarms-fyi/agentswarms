// Bundled sample dataset loader.
//
// Sample datasets are SHARED across all users — global rows in
// user_data_tables with user_id = NULL and is_sample = true. The first
// authenticated user to visit /data-sql triggers the seed via two
// SECURITY DEFINER RPCs (`upsert_sample_dataset` + `insert_sample_rows`).
// Everyone else just reads the same rows through RLS.

import sampleCsvUrl from "@/assets/sample-data/saas_sales.csv?url";
import budgetCsvUrl from "@/assets/sample-data/q3_budget_variance.csv?url";
import adverseEventsCsvUrl from "@/assets/sample-data/adverse_event_reports.csv?url";
import autoClaimsCsvUrl from "@/assets/sample-data/auto_claims_history.csv?url";
import factoryDefectsCsvUrl from "@/assets/sample-data/factory_defect_log.csv?url";
import siemAlertsCsvUrl from "@/assets/sample-data/siem_alerts.csv?url";
import ecomReturnsCsvUrl from "@/assets/sample-data/ecom_returns.csv?url";
import nbaSeasonsCsvUrl from "@/assets/sample-data/nba_team_seasons.csv?url";
import worldHealthCsvUrl from "@/assets/sample-data/world_health_indicators.csv?url";
import globalElectricityCsvUrl from "@/assets/sample-data/global_electricity.csv?url";
import f1DriverStandingsCsvUrl from "@/assets/sample-data/f1_driver_standings.csv?url";
import f1ConstructorStandingsCsvUrl from "@/assets/sample-data/f1_constructor_standings.csv?url";
import f1WorldChampionsCsvUrl from "@/assets/sample-data/f1_world_champions.csv?url";
import f1ConstructorChampionsCsvUrl from "@/assets/sample-data/f1_constructor_champions.csv?url";
import supplyShipmentsCsvUrl from "@/assets/sample-data/supply_shipments.csv?url";
import supplyScorecardCsvUrl from "@/assets/sample-data/supply_carrier_scorecard.csv?url";
import hrRosterCsvUrl from "@/assets/sample-data/hr_roster.csv?url";
import hrDeptMonthlyCsvUrl from "@/assets/sample-data/hr_dept_monthly.csv?url";
import { parseCsv } from "@/lib/sqlEngine";
import { supabase } from "@/integrations/supabase/client";

export const SAMPLE_TABLE_NAME = "saas_sales";
export const SAMPLE_FILENAME = "SaaS-Sales.csv";

// Second sample dataset — used by the Financial Variance (ERP + RAG) swarm
// template. Seeded alongside saas_sales.
export const BUDGET_TABLE_NAME = "q3_budget_variance";
export const BUDGET_FILENAME = "Q3_Budget_Variance.csv";

// Third sample dataset — used by the Agentic RAG (Pharmacovigilance)
// swarm template. A synthetic adverse-event report ledger across three
// drugs (Cardenolex, Rhythmoral, Vasostatil).
export const ADVERSE_EVENTS_TABLE_NAME = "adverse_event_reports";
export const ADVERSE_EVENTS_FILENAME = "Adverse_Event_Reports.csv";

// Fourth — Insurance (auto FNOL triage swarm).
export const AUTO_CLAIMS_TABLE_NAME = "auto_claims_history";
export const AUTO_CLAIMS_FILENAME = "Auto_Claims_History.csv";

// Fifth — Manufacturing (quality NCR / RCA swarm).
export const FACTORY_DEFECTS_TABLE_NAME = "factory_defect_log";
export const FACTORY_DEFECTS_FILENAME = "Factory_Defect_Log.csv";

// Sixth — Cybersecurity (SOC alert triage swarm).
export const SIEM_ALERTS_TABLE_NAME = "siem_alerts";
export const SIEM_ALERTS_FILENAME = "SIEM_Alerts.csv";

// Seventh — Retail (returns & reverse-logistics swarm).
export const ECOM_RETURNS_TABLE_NAME = "ecom_returns";
export const ECOM_RETURNS_FILENAME = "Ecom_Returns.csv";

// Eighth — Sports analytics (FiveThirtyEight NBA Elo, CC-BY 4.0),
// aggregated to team-seasons 1977-2015. Backs the sample BI dashboard.
export const NBA_SEASONS_TABLE_NAME = "nba_team_seasons";
export const NBA_SEASONS_FILENAME = "NBA_Team_Seasons.csv";

// Ninth — Healthcare (World Bank Open Data, CC-BY 4.0): life expectancy,
// health spending, physicians, infant mortality for 45 countries 2000-2022.
export const WORLD_HEALTH_TABLE_NAME = "world_health_indicators";
export const WORLD_HEALTH_FILENAME = "World_Health_Indicators.csv";

// Tenth — Energy & utilities (Our World in Data energy dataset, CC-BY 4.0):
// electricity generation by source for World + 28 countries, 1990-2023.
export const GLOBAL_ELECTRICITY_TABLE_NAME = "global_electricity";
export const GLOBAL_ELECTRICITY_FILENAME = "Global_Electricity.csv";

// Eleventh–fourteenth — Formula 1 (Ergast/Jolpica public API, no auth):
// the 2025 driver + constructor standings and the full 1950-2025 world &
// constructor champions history. Back the "Formula 1 Analytics" sample
// multi-page dashboard.
export const F1_DRIVER_STANDINGS_TABLE_NAME = "f1_driver_standings";
export const F1_DRIVER_STANDINGS_FILENAME = "F1_Driver_Standings.csv";
export const F1_CONSTRUCTOR_STANDINGS_TABLE_NAME = "f1_constructor_standings";
export const F1_CONSTRUCTOR_STANDINGS_FILENAME = "F1_Constructor_Standings.csv";
export const F1_WORLD_CHAMPIONS_TABLE_NAME = "f1_world_champions";
export const F1_WORLD_CHAMPIONS_FILENAME = "F1_World_Champions.csv";
export const F1_CONSTRUCTOR_CHAMPIONS_TABLE_NAME = "f1_constructor_champions";
export const F1_CONSTRUCTOR_CHAMPIONS_FILENAME = "F1_Constructor_Champions.csv";

// Fifteenth–sixteenth — Supply chain (synthetic, generated by
// scripts/buildBiSamples.ts): 360 shipments Jan 2025 – Jun 2026, plus the
// month × carrier scorecard that the "Carrier scorecard · Sample" prep flow
// produces from them. Back the "Supply Chain Pulse · Sample" dashboard and
// the Logistics Operations Handbook knowledge base.
export const SUPPLY_SHIPMENTS_TABLE_NAME = "supply_shipments";
export const SUPPLY_SHIPMENTS_FILENAME = "Supply_Shipments.csv";
export const SUPPLY_SCORECARD_TABLE_NAME = "supply_carrier_scorecard";
export const SUPPLY_SCORECARD_FILENAME = "Supply_Carrier_Scorecard.csv";

// Seventeenth–eighteenth — People analytics (synthetic, same generator): a
// 420-person roster plus the month × department headcount/attrition rollup
// derived from it. Back the "People Analytics · Sample" dashboard and the
// People Operations Playbook knowledge base.
export const HR_ROSTER_TABLE_NAME = "hr_roster";
export const HR_ROSTER_FILENAME = "HR_Roster.csv";
export const HR_DEPT_MONTHLY_TABLE_NAME = "hr_dept_monthly";
export const HR_DEPT_MONTHLY_FILENAME = "HR_Dept_Monthly.csv";

type SampleSpec = { tableName: string; filename: string; csvUrl: string };

const SAMPLES: SampleSpec[] = [
  { tableName: SAMPLE_TABLE_NAME, filename: SAMPLE_FILENAME, csvUrl: sampleCsvUrl },
  { tableName: BUDGET_TABLE_NAME, filename: BUDGET_FILENAME, csvUrl: budgetCsvUrl },
  {
    tableName: ADVERSE_EVENTS_TABLE_NAME,
    filename: ADVERSE_EVENTS_FILENAME,
    csvUrl: adverseEventsCsvUrl,
  },
  { tableName: AUTO_CLAIMS_TABLE_NAME, filename: AUTO_CLAIMS_FILENAME, csvUrl: autoClaimsCsvUrl },
  {
    tableName: FACTORY_DEFECTS_TABLE_NAME,
    filename: FACTORY_DEFECTS_FILENAME,
    csvUrl: factoryDefectsCsvUrl,
  },
  { tableName: SIEM_ALERTS_TABLE_NAME, filename: SIEM_ALERTS_FILENAME, csvUrl: siemAlertsCsvUrl },
  {
    tableName: ECOM_RETURNS_TABLE_NAME,
    filename: ECOM_RETURNS_FILENAME,
    csvUrl: ecomReturnsCsvUrl,
  },
  { tableName: NBA_SEASONS_TABLE_NAME, filename: NBA_SEASONS_FILENAME, csvUrl: nbaSeasonsCsvUrl },
  {
    tableName: WORLD_HEALTH_TABLE_NAME,
    filename: WORLD_HEALTH_FILENAME,
    csvUrl: worldHealthCsvUrl,
  },
  {
    tableName: GLOBAL_ELECTRICITY_TABLE_NAME,
    filename: GLOBAL_ELECTRICITY_FILENAME,
    csvUrl: globalElectricityCsvUrl,
  },
  {
    tableName: F1_DRIVER_STANDINGS_TABLE_NAME,
    filename: F1_DRIVER_STANDINGS_FILENAME,
    csvUrl: f1DriverStandingsCsvUrl,
  },
  {
    tableName: F1_CONSTRUCTOR_STANDINGS_TABLE_NAME,
    filename: F1_CONSTRUCTOR_STANDINGS_FILENAME,
    csvUrl: f1ConstructorStandingsCsvUrl,
  },
  {
    tableName: F1_WORLD_CHAMPIONS_TABLE_NAME,
    filename: F1_WORLD_CHAMPIONS_FILENAME,
    csvUrl: f1WorldChampionsCsvUrl,
  },
  {
    tableName: F1_CONSTRUCTOR_CHAMPIONS_TABLE_NAME,
    filename: F1_CONSTRUCTOR_CHAMPIONS_FILENAME,
    csvUrl: f1ConstructorChampionsCsvUrl,
  },
  {
    tableName: SUPPLY_SHIPMENTS_TABLE_NAME,
    filename: SUPPLY_SHIPMENTS_FILENAME,
    csvUrl: supplyShipmentsCsvUrl,
  },
  {
    tableName: SUPPLY_SCORECARD_TABLE_NAME,
    filename: SUPPLY_SCORECARD_FILENAME,
    csvUrl: supplyScorecardCsvUrl,
  },
  { tableName: HR_ROSTER_TABLE_NAME, filename: HR_ROSTER_FILENAME, csvUrl: hrRosterCsvUrl },
  {
    tableName: HR_DEPT_MONTHLY_TABLE_NAME,
    filename: HR_DEPT_MONTHLY_FILENAME,
    csvUrl: hrDeptMonthlyCsvUrl,
  },
];

// Returns true if at least one fresh seed was performed; false if all already existed.
export async function ensureSampleDataset(_userId: string): Promise<boolean> {
  let seededAny = false;
  for (const spec of SAMPLES) {
    const seeded = await ensureOneSample(spec);
    if (seeded) seededAny = true;
  }
  return seededAny;
}

export async function forceSeedSampleDataset(_userId: string): Promise<void> {
  for (const spec of SAMPLES) {
    await seedPublicSample(spec);
  }
}

async function ensureOneSample(spec: SampleSpec): Promise<boolean> {
  const { data: existing } = await supabase
    .from("user_data_tables")
    .select("id")
    .eq("name", spec.tableName)
    .eq("is_sample", true)
    .is("user_id", null)
    .maybeSingle();
  if (existing) return false;
  await seedPublicSample(spec);
  return true;
}

async function seedPublicSample(spec: SampleSpec): Promise<void> {
  const res = await fetch(spec.csvUrl);
  if (!res.ok) throw new Error(`Failed to fetch sample CSV (${res.status})`);
  const text = await res.text();
  const { rows, columns } = await parseCsv(text);

  const { data: tableId, error: upsertErr } = await supabase.rpc("upsert_sample_dataset", {
    _name: spec.tableName,
    _source_filename: spec.filename,
    _columns: columns as any,
  });
  if (upsertErr || !tableId)
    throw new Error(upsertErr?.message || "Failed to register sample table");

  const { count } = await supabase
    .from("user_data_rows")
    .select("id", { count: "exact", head: true })
    .eq("table_id", tableId);
  if ((count ?? 0) > 0) return;

  const BATCH = 1000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await supabase.rpc("insert_sample_rows", {
      _table_id: tableId,
      _rows: slice as any,
    });
    if (error) throw new Error(error.message);
  }
}
