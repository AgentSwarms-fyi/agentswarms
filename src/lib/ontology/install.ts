// "The tables are not there yet", said as what to do about it.
//
// An install that updated the app but not its database answers every ontology
// call with PostgREST's "Could not find the table 'public.ontologies' in the
// schema cache" (or Postgres's "relation … does not exist"). That is true and
// useless to the person reading it; this turns it into the one step that fixes
// it, and leaves every other error as it was.
export const ONTOLOGY_MIGRATION = "20261030000000_enterprise_ontology.sql";

export function notInstalledMessage(error: string | null | undefined): string | null {
  if (!error) return null;
  const tables = /(ontologies|ontology_(versions|proposals|rule_runs|actions|questions))\b/;
  const missing =
    /schema cache/i.test(error) || /does not exist/i.test(error) || /PGRST205|42P01/.test(error);
  if (!tables.test(error) || !missing) return null;
  return (
    "Enterprise Ontology is not set up on this database yet. Apply the migration " +
    `${ONTOLOGY_MIGRATION} (npx supabase db push --include-all), then reload.`
  );
}
