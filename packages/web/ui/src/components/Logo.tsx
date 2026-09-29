/**
 * axi-arena mark: an abstract Colosseum in purple.
 *
 * The facade is the front half of an ellipse seen from slightly above, so every tier line bows
 * toward the viewer and the arches foreshorten toward the edges. Three arcaded tiers with
 * pilasters, a windowed attic, and the famous ruin: the outer ring breaks away in steps on the
 * right, revealing the inner ring behind it. All geometry is computed here (viewBox 64×64) so the
 * header mark and the favicon are the same drawing.
 */

const CX = 32;
const A_OUT = 25; // outer ring half-width
const A_IN = 22; // inner ring half-width
const BOW = 3.6; // how far the middle of each tier line sits below its ends (perspective)
const BASE = 50.5; // ground line at the edges

// Tier boundaries at the edges (y), bottom to top: ground arcade, middle arcade, upper arcade, attic.
const T = { ground: [BASE, 41.5], middle: [41.5, 33], upper: [33, 24.5], attic: [24.5, 17.5] } as const;

const COLS = 9; // arches per tier across the visible front
const TH0 = Math.PI * 1.06; // leftmost visible angle
const TH1 = Math.PI * 1.94; // rightmost visible angle

const f = (n: number) => Math.round(n * 100) / 100;
const xAt = (a: number, th: number) => CX + a * Math.cos(th);
/** Tier line y at angle th: the front bulges down by BOW (th = 1.5π is dead center). */
const yAt = (y: number, th: number) => y - BOW * Math.sin(th) - BOW;

/** Smooth tier line from th0 to th1 as a polyline. */
function tierLine(a: number, y: number, th0: number, th1: number, steps = 24): string {
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const th = th0 + ((th1 - th0) * i) / steps;
    pts.push(`${f(xAt(a, th))} ${f(yAt(y, th))}`);
  }
  return pts.join("L");
}

/** Column centers (angles), evenly spaced in angle so they foreshorten toward the edges. */
const colAngles = Array.from({ length: COLS }, (_, i) => TH0 + ((TH1 - TH0) * (i + 0.5)) / COLS);
const colWidth = (a: number, th: number) => a * Math.abs(Math.sin(th)) * ((TH1 - TH0) / COLS);

/** Arch opening (round top) centered at angle th, within a tier band, on a ring of half-width a. */
function arch(a: number, th: number, top: number, bottom: number, fill = 0.56): string {
  const w = colWidth(a, th) * fill;
  const x = xAt(a, th) - w / 2;
  const yb = yAt(bottom, th) - 0.9;
  const yt = yAt(top, th) + 1.3;
  const r = w / 2;
  return `M${f(x)} ${f(yb)}V${f(yt + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(yt + r)}V${f(yb)}Z`;
}

/** Small attic window (rectangular) centered at angle th. */
function window_(th: number): string {
  const w = colWidth(A_OUT, th) * 0.3;
  const x = xAt(A_OUT, th) - w / 2;
  const top = yAt(T.attic[1], th) + 1.8;
  const bottom = yAt(T.attic[0], th) - 1.6;
  return `M${f(x)} ${f(top)}H${f(x + w)}V${f(bottom)}H${f(x)}Z`;
}

// The ruin slopes down to the right: from RUIN_UPPER the attic is gone, from RUIN_MIDDLE the upper
// arcade too, so the inner ring shows through the gap.
const RUIN_UPPER = 5;
const RUIN_MIDDLE = 6;

/** Height (edge-y) of the outer wall's top at a column index. */
const wallTop = (i: number) => (i >= RUIN_MIDDLE ? T.middle[1] : i >= RUIN_UPPER ? T.upper[1] : T.attic[1]);

/** Outer wall silhouette: bottom arc left→right, then a stepped, slightly jagged top back to the left. */
function outerWall(): string {
  const bottom = tierLine(A_OUT, BASE, TH0, TH1);
  const edges = colAngles.map((th, i) => th - (TH1 - TH0) / COLS / 2 + (i === 0 ? 0 : 0));
  const topPts: string[] = [];
  // Walk right→left along the top, stepping at ruin boundaries with a broken, jagged edge.
  for (let i = COLS - 1; i >= 0; i--) {
    const thR = i === COLS - 1 ? TH1 : edges[i + 1];
    const thL = i === 0 ? TH0 : edges[i];
    const y = wallTop(i);
    const nextY = i > 0 ? wallTop(i - 1) : y;
    topPts.push(`${f(xAt(A_OUT, thR))} ${f(yAt(y, thR))}`);
    if (nextY !== y) {
      // Jagged break: a couple of rough steps between this height and the next (higher) one.
      const xm = xAt(A_OUT, thL);
      const y0 = yAt(y, thL);
      const y1 = yAt(nextY, thL);
      topPts.push(`${f(xm + 0.9)} ${f(y0)}`, `${f(xm + 0.4)} ${f(y0 - (y0 - y1) * 0.45)}`, `${f(xm + 1.1)} ${f(y0 - (y0 - y1) * 0.62)}`, `${f(xm)} ${f(y1)}`);
    } else {
      topPts.push(`${f(xAt(A_OUT, thL))} ${f(yAt(y, thL))}`);
    }
  }
  return `M${bottom}L${topPts.join("L")}Z`;
}

// Inner ring: lower than the outer wall, so it only shows through the ruined gap on the right.
const INNER_TOP = 26.5;
const INNER_TH0 = Math.PI * 1.5;
const INNER_TH1 = Math.PI * 1.995;

function innerRing(): string {
  return `M${tierLine(A_IN, T.ground[1], INNER_TH0, INNER_TH1)}L${tierLine(A_IN, INNER_TOP, INNER_TH1, INNER_TH0)}Z`;
}

function innerArches(): string {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const th = INNER_TH0 + ((INNER_TH1 - INNER_TH0) * (i + 0.5)) / 7;
    const w = A_IN * Math.abs(Math.sin(th)) * ((INNER_TH1 - INNER_TH0) / 7) * 0.5;
    const x = xAt(A_IN, th) - w / 2;
    const yt = yAt(INNER_TOP, th) + 1.6;
    const yb = yAt(T.middle[1] + 1.5, th);
    out.push(`M${f(x)} ${f(yb)}V${f(yt + w / 2)}A${f(w / 2)} ${f(w / 2)} 0 0 1 ${f(x + w)} ${f(yt + w / 2)}V${f(yb)}Z`);
  }
  return out.join("");
}

function outerOpenings(): string {
  const out: string[] = [];
  colAngles.forEach((th, i) => {
    out.push(arch(A_OUT, th, T.ground[1], T.ground[0]));
    out.push(arch(A_OUT, th, T.middle[1], T.middle[0]));
    if (i < RUIN_MIDDLE) out.push(arch(A_OUT, th, T.upper[1], T.upper[0]));
    if (i < RUIN_UPPER) out.push(window_(th));
  });
  return out.join("");
}

function cornices(): string {
  const edge = (i: number) => (i >= COLS ? TH1 : colAngles[i] - (TH1 - TH0) / COLS / 2);
  return [
    `M${tierLine(A_OUT, T.ground[1], TH0, TH1)}`,
    `M${tierLine(A_OUT, T.middle[1], TH0, TH1)}`,
    `M${tierLine(A_OUT, T.upper[1], TH0, edge(RUIN_MIDDLE))}`,
    `M${tierLine(A_OUT, T.attic[0], TH0, edge(RUIN_UPPER))}`,
  ].join("");
}

export const LOGO = {
  outerWall: outerWall(),
  outerOpenings: outerOpenings(),
  innerRing: innerRing(),
  innerArches: innerArches(),
  cornices: cornices(),
  shadow: `M${f(CX - 27)} ${f(BASE + 0.5)}Q${CX} ${f(BASE + 2 * BOW + 3)} ${f(CX + 27)} ${f(BASE + 0.5)}Q${CX} ${f(BASE + 2 * BOW + 0.5)} ${f(CX - 27)} ${f(BASE + 0.5)}Z`,
};

const PALETTE = {
  bgTop: "#7c3aed",
  bgBottom: "#2e1065",
  stoneLight: "#f5f0ff",
  stoneEdge: "#c4b5fd",
  innerStone: "#a78bfa",
  opening: "#3b0f7a",
  openingInner: "#24084f",
  cornice: "#8b5cf6",
  shadow: "#1e0845",
};

/** SVG markup (no CSS variables), shared by the React mark and the favicon. */
export function logoSvg(idPrefix = "axl"): string {
  const p = PALETTE;
  const g = (s: string) => `${idPrefix}-${s}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs>
<linearGradient id="${g("bg")}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${p.bgTop}"/><stop offset="1" stop-color="${p.bgBottom}"/></linearGradient>
<radialGradient id="${g("glow")}" cx="0.5" cy="0.32" r="0.6"><stop offset="0" stop-color="#c4b5fd" stop-opacity="0.35"/><stop offset="1" stop-color="#c4b5fd" stop-opacity="0"/></radialGradient>
<linearGradient id="${g("stone")}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${p.stoneEdge}"/><stop offset="0.45" stop-color="${p.stoneLight}"/><stop offset="0.62" stop-color="${p.stoneLight}"/><stop offset="1" stop-color="${p.stoneEdge}"/></linearGradient>
<linearGradient id="${g("hole")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.openingInner}"/><stop offset="1" stop-color="${p.opening}"/></linearGradient>
</defs>
<rect width="64" height="64" rx="14" fill="url(#${g("bg")})"/>
<rect width="64" height="64" rx="14" fill="url(#${g("glow")})"/>
<path d="${LOGO.shadow}" fill="${p.shadow}" opacity="0.45"/>
<path d="${LOGO.innerRing}" fill="${p.innerStone}"/>
<path d="${LOGO.innerArches}" fill="${p.openingInner}"/>
<path d="${LOGO.outerWall}" fill="url(#${g("stone")})"/>
<path d="${LOGO.cornices}" fill="none" stroke="${p.cornice}" stroke-width="0.8" stroke-linecap="round"/>
<path d="${LOGO.outerOpenings}" fill="url(#${g("hole")})"/>
</svg>`;
}

export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <span
      className="logo-mark"
      style={{ width: size, height: size }}
      aria-hidden="true"
      // Static, self-generated SVG (no user data), so injecting it is safe.
      dangerouslySetInnerHTML={{ __html: logoSvg() }}
    />
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
