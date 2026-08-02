import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const { data } = await sb
  .from("bi_dashboards")
  .select("name, published, public_slug, widgets")
  .eq("published", true);
for (const d of data ?? []) {
  const w = Array.isArray(d.widgets) ? d.widgets : [];
  const kinds = [...new Set(w.map((x: any) => x?.chart?.type ?? x?.kind).filter(Boolean))];
  console.log(`  ${d.name}\n    slug: ${d.public_slug}\n    widgets: ${w.length}  chart types: ${kinds.join(", ")}`);
}
