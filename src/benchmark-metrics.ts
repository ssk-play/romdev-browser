export interface Distribution { count: number; p50: number; p95: number; p99: number; max: number }
/** The current match window is 60. Keep 24 selectable to compare against historical reports. */
export function benchmarkPlan(query: { get(name: string): string | null }) {
  const smoke = query.get("profile") === "smoke";
  const depth = query.get("window") === "24" ? 24 : 60;
  return { smoke, depth, warmupBursts: smoke ? 0 : 2, measuredBursts: smoke ? 2 : 200 };
}
/** Nearest-rank percentiles. Empty samples are unavailable, never a fabricated zero. */
export function distribution(samples: readonly number[]): Distribution | null {
  if (!samples.length) return null;
  if (samples.some((v) => !Number.isFinite(v) || v < 0)) throw new Error("invalid timing sample");
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { count: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1)! };
}
