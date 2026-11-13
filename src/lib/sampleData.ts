// Asking for the shared sample datasets (R454).
//
// Sample datasets are SHARED across all users: global rows in user_data_tables with
// user_id = NULL and is_sample = true. The first signed-in user to open /data-sql has
// the server seed them, from the CSVs it ships with. The browser sends no content, so
// nobody can put anything into a table every other tenant reads.
import { withToken } from "@/lib/chatHistory";
import { seedSampleDatasetsFn } from "@/utils/sampleDatasets.functions";

export * from "@/lib/sampleDatasetNames";

// Returns true if at least one fresh seed was performed; false if all already existed.
export async function ensureSampleDataset(_userId: string): Promise<boolean> {
  const r = await withToken((t) => seedSampleDatasetsFn({ data: { access_token: t } }));
  if (r.error) throw new Error(r.error.message);
  return r.data?.seeded ?? false;
}
