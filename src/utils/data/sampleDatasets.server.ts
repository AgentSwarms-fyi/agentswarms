// Seeding the shared sample datasets (R454).
//
// Every tenant reads these, so what goes in them is decided here and nowhere else: the
// CSVs this build ships with, written by the service role. The browser used to do this
// through two database functions that took whatever it sent, which let anyone signed in
// write into tables everyone else reads.
import Papa from "papaparse";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { typedDataset, type ColumnDef } from "@/lib/datasetParse";
import { SAMPLE_DATASETS, type SampleDataset } from "@/lib/sampleDatasetNames";
import { insertSampleRows } from "@/utils/data/datasetRows.server";

const CSV_DIR = "/src/assets/sample-data";
const CSV = import.meta.glob<string>("/src/assets/sample-data/*.csv", {
  query: "?raw",
  import: "default",
  eager: true,
});

function parseSample(tableName: string) {
  const text = CSV[`${CSV_DIR}/${tableName}.csv`];
  if (!text) throw new Error(`no CSV ships for sample ${tableName}`);
  const { data } = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false, // as parseCsv: coerced after, so date strings stay strings
  });
  return typedDataset(data);
}

async function registerSample(sample: SampleDataset, columns: ColumnDef[]): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("user_data_tables")
    .insert({
      user_id: null,
      name: sample.tableName,
      source_filename: sample.filename,
      columns: columns as unknown as Json,
      is_sample: true,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`could not register sample ${sample.tableName}: ${error?.message}`);
  }
  return data.id;
}

async function seedOne(sample: SampleDataset): Promise<void> {
  const { rows, columns } = parseSample(sample.tableName);
  const tableId = await registerSample(sample, columns);
  const { error } = await insertSampleRows(tableId, rows);
  if (!error) return;
  // Registered is what "there" means to the next run, so a sample left like this would
  // stay empty, or short by the batches that did not go in, for every tenant. Its rows
  // go with it.
  const { error: undo } = await supabaseAdmin.from("user_data_tables").delete().eq("id", tableId);
  const left = undo ? `, and it is still registered: ${undo.message}` : "";
  throw new Error(`could not seed sample ${sample.tableName}: ${error.message}${left}`);
}

async function seedAll(): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("user_data_tables")
    .select("name")
    .eq("is_sample", true)
    .is("user_id", null);
  // A failed check is not an absent sample: seeding on it would register them all again.
  if (error) throw new Error(`could not check for samples: ${error.message}`);
  const known = new Set((data ?? []).map((t) => t.name));

  const missing = SAMPLE_DATASETS.filter((s) => !known.has(s.tableName));
  for (const sample of missing) await seedOne(sample);
  return missing.length > 0;
}

let inFlight: Promise<boolean> | null = null;

/**
 * Add any sample that is missing, and never touch one that is there. Returns whether
 * anything was seeded. A page load asks for this every time, so callers arriving
 * together share one run.
 */
export function seedSampleDatasets(): Promise<boolean> {
  inFlight ??= seedAll().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
