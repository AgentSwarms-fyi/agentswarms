// What a pipeline starts when it succeeds, beyond another pipeline.
//
// Pure: the row's two columns become one plain answer the run finaliser acts
// on and the editor validates against, so the two cannot read them
// differently. `chain_sql_models` has three states on purpose — NULL is
// "nothing", an empty list is "every active model", names are "these, with
// their ancestors" — because "build everything" is the common case and a
// pipeline should not have to list models it did not write.

export type ChainTargets = {
  /** null: build nothing; []: every active model; names: these and their ancestors. */
  sqlModels: string[] | null;
  /** ML schedules (retrain / batch predict) to start, by id. */
  mlSchedules: string[];
};

export function chainTargetsOf(row: {
  chain_sql_models?: string[] | null;
  chain_ml_schedules?: string[] | null;
}): ChainTargets {
  const models = row.chain_sql_models;
  return {
    sqlModels: Array.isArray(models)
      ? [...new Set(models.map((m) => m.trim()).filter(Boolean))]
      : null,
    mlSchedules: Array.isArray(row.chain_ml_schedules)
      ? [...new Set(row.chain_ml_schedules.filter(Boolean))]
      : [],
  };
}

/** Does this pipeline start anything besides another pipeline? */
export function hasChainTargets(t: ChainTargets): boolean {
  return t.sqlModels !== null || t.mlSchedules.length > 0;
}

/**
 * Why a chain configuration cannot be saved, or null.
 *
 * Names must be the owner's own models and schedules must be the owner's own
 * — a pipeline cannot build or train something it could not see — and the
 * refusal names the missing one, because "invalid chain" sends someone
 * hunting through two other pages.
 */
export function validateChainTargets(
  t: ChainTargets,
  known: { modelNames: string[]; scheduleIds: string[] },
): string | null {
  const models = new Set(known.modelNames);
  const missingModel = (t.sqlModels ?? []).find((m) => !models.has(m));
  if (missingModel) {
    return `No SQL model named "${missingModel}" — the chain can only build models you own.`;
  }
  const schedules = new Set(known.scheduleIds);
  if (t.mlSchedules.some((id) => !schedules.has(id))) {
    return "One of the ML schedules no longer exists, or is not yours.";
  }
  return null;
}

/** The sentence the pipeline list shows beside a chained pipeline. */
export function describeChain(t: ChainTargets): string | null {
  const parts: string[] = [];
  if (t.sqlModels !== null) {
    parts.push(
      t.sqlModels.length === 0
        ? "builds every SQL model"
        : `builds ${t.sqlModels.length} SQL model${t.sqlModels.length === 1 ? "" : "s"}`,
    );
  }
  if (t.mlSchedules.length) {
    parts.push(`runs ${t.mlSchedules.length} ML schedule${t.mlSchedules.length === 1 ? "" : "s"}`);
  }
  return parts.length ? `then ${parts.join(" and ")}` : null;
}
