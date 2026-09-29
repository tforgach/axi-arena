/**
 * axi-arena mark: an abstract Colosseum. Three tiers of arches on a curved facade (arches
 * narrow toward the edges), with the top tier broken off on the right like the real ruin.
 * Geometry lives in LOGO_PATHS so the favicon and the header mark stay identical.
 */

/** Arch opening: straight sides, round top. */
function arch(x: number, w: number, top: number, bottom: number): string {
  const r = w / 2;
  return `M${x} ${bottom}V${top + r}A${r} ${r} 0 0 1 ${x + w} ${top + r}V${bottom}Z`;
}

// Facade: full height on the left, stepped down on the right (the ruined upper ring).
const WALL = "M4.5 25.5V7.5H18.5L20.5 9.5V12.5H27.5V25.5Z";

// Columns across the curved facade: narrower at the edges to read as curvature.
const COLS: [number, number][] = [
  [6.2, 2.2],
  [10.2, 3],
  [14.5, 3],
  [18.8, 3],
  [23.1, 2.2],
];

const TIERS = {
  ground: { top: 19.5, bottom: 25.5, cols: COLS },
  middle: { top: 13.5, bottom: 17.5, cols: COLS },
  upper: { top: 8.8, bottom: 11.6, cols: COLS.slice(0, 3) },
};

export const LOGO_PATHS = {
  wall: WALL,
  openings: Object.values(TIERS)
    .flatMap((t) => t.cols.map(([x, w]) => arch(x, w, t.top, t.bottom)))
    .join(""),
  // Cornices between tiers.
  ledges: "M4.5 18.5H27.5M4.5 12.5H20.5",
};

export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="logo-mark">
      <rect width="32" height="32" rx="7.5" fill="var(--accent)" />
      <path d={LOGO_PATHS.wall} fill="#fff" />
      <path d={LOGO_PATHS.openings} fill="var(--accent)" />
      <path d={LOGO_PATHS.ledges} stroke="var(--accent)" strokeWidth="0.9" />
    </svg>
  );
}

export function Logo() {
  return (
    <a className="brand" href="#/" aria-label="axi-arena, all runs">
      <LogoMark />
      <span>axi-arena</span>
    </a>
  );
}

/** Standalone SVG for the favicon (no CSS variables available there). */
export function faviconSvg(accent = "#2a78d6"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7.5" fill="${accent}"/><path d="${LOGO_PATHS.wall}" fill="#fff"/><path d="${LOGO_PATHS.openings}" fill="${accent}"/><path d="${LOGO_PATHS.ledges}" stroke="${accent}" stroke-width="0.9"/></svg>`;
}
