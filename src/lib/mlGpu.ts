// What a version's training sandbox had for a GPU, as the model page says it
// (R537). The trainer reports it (`gpu` on the version's config); this reads
// it back without trusting its shape, and words it.

export type GpuReport = {
  requested: number;
  seen: { name: string; memory_mb: number | null; driver: string }[];
  device: "cuda" | null;
  note?: string;
  used_by?: string[];
};

/** The version's GPU report, or null when no GPU was asked for or seen. */
export function gpuReportOf(config: unknown): GpuReport | null {
  const g = (config as { gpu?: unknown } | null)?.gpu as Partial<GpuReport> | undefined;
  if (!g || typeof g !== "object") return null;
  const requested =
    typeof g.requested === "number" && Number.isFinite(g.requested) ? g.requested : 0;
  const seen = (Array.isArray(g.seen) ? g.seen : [])
    .filter((s) => s && typeof s.name === "string")
    .map((s) => ({
      name: s.name,
      memory_mb: typeof s.memory_mb === "number" ? s.memory_mb : null,
      driver: typeof s.driver === "string" ? s.driver : "",
    }));
  if (requested <= 0 && seen.length === 0) return null;
  return {
    requested,
    seen,
    device: g.device === "cuda" ? "cuda" : null,
    ...(typeof g.note === "string" && g.note ? { note: g.note } : {}),
    ...(Array.isArray(g.used_by)
      ? { used_by: g.used_by.filter((u): u is string => typeof u === "string") }
      : {}),
  };
}

/** "1× NVIDIA L4 (22 GiB)", or "2× NVIDIA L4 (22 GiB each)". */
export function gpuNames(seen: GpuReport["seen"]): string {
  const counts = new Map<string, number>();
  for (const s of seen) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  const mem = seen[0]?.memory_mb;
  const each = seen.length > 1 ? " each" : "";
  const size = mem ? ` (${Math.round(mem / 1024)} GiB${each})` : "";
  return [...counts].map(([name, n]) => `${n}× ${name}`).join(", ") + size;
}

/** The one line the Lineage card shows. */
export function gpuLine(g: GpuReport): string {
  if (g.device === "cuda") {
    const used = g.used_by?.length
      ? `${g.used_by.join(", ")} trained on it`
      : "no candidate trained on it";
    return `${gpuNames(g.seen)}; ${used}`;
  }
  if (g.requested > 0) {
    const note = (g.note ?? "none was visible").replace(/\.$/, "");
    return `${g.requested} requested but not usable (${note}); trained on the CPU`;
  }
  return `${gpuNames(g.seen)}, not used`;
}
