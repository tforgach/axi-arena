export const num = (n: number | null | undefined, digits = 0) =>
  n == null || Number.isNaN(n) ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const compact = (n: number | null | undefined) =>
  n == null ? "–" : n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Arena Score display: 100 × score, signed, with a true minus sign. */
export const score = (s: number) => `${s >= 0 ? "+" : "−"}${num(Math.abs(s * 100), 1)}`;

export const pct = (x: number | null | undefined) => (x == null ? "–" : `${num(x * 100, 0)}%`);

export const secs = (ms: number | null | undefined) => (ms == null ? "–" : `${num(ms / 1000, 1)}s`);

/** AXI relative to baseline, e.g. "−34%" means the AXI used 34% less. */
export const relDelta = (axi: number, base: number) => {
  if (!(base > 0)) return "–";
  const d = axi / base - 1;
  return `${d <= 0 ? "−" : "+"}${num(Math.abs(d) * 100, 0)}%`;
};

export const ciText = (ci: [number, number] | null) => (ci ? `${score(ci[0])} to ${score(ci[1])}` : "n<2");

export function when(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function duration(from: string | null, to: string | null): string {
  if (!from) return "–";
  const ms = (to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime();
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
