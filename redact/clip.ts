/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T094 — Vector-crossing clip-instead-of-remove.
 *
 * Before T094 the adapter applied MuPDF's REDACT_LINE_ART_REMOVE_IF_TOUCHED,
 * which deletes any vector path touched by a mark *in full* — including the
 * portions outside the mark. That destroys public vector content (axes, grid
 * lines, diagram strokes) that merely crosses a redaction rectangle, and the
 * independent verifier correctly reports it as verify.visual.outside-damage.
 *
 * This module implements the founder-approved replacement: a destructive
 * content-stream rewrite that *clips* touched strokes at the mark boundary.
 * For every stroked path touched by a mark it:
 *
 * - partitions each subpath into kept / removed runs by intersecting the
 *   centerline with the mark rectangles (exact interval math for lines,
 *   conservative convex-hull subdivision for beziers);
 * - re-emits only the kept runs as new path objects with identical stroke
 *   state (width, join, dash with phase adjusted per run, color) and butt
 *   caps at the cut ends so no new paint crosses into the mark;
 * - restores round/square caps at original subpath ends as explicit filled
 *   shapes so outside rendering is pixel-identical;
 * - omits the removed runs entirely: the marked portion of the vector
 *   geometry is genuinely gone from the file, not merely covered.
 *
 * Fill paths keep the previous behavior: a fill touched by a mark is removed
 * whole (fills are regions, not strokes — clipping them would change the
 * region outside the mark). Unpainted/clip-only paths pass through verbatim.
 *
 * Fail-closed rules (any violation throws ClipError, which the adapter lets
 * propagate so the transform fails with no candidate):
 * - any operator outside a fixed whitelist, malformed operands, unbalanced
 *   q/Q or BT/ET;
 * - graphics-state tricks inside path construction (q/Q/cm/Do/sh/inline
 *   images/marked-content between the first construction op and the paint);
 * - an active external graphics state (gs) on a touched path;
 * - a W (clip) operator on a painted path;
 * - a current transformation matrix that is not a uniform axis-aligned
 *   scale+translate (rotation/skew/non-uniform scale cannot be clipped
 *   exactly in stream-local space);
 * - a bezier that is still ambiguous at the maximum subdivision depth
 *   (dropped — safe — rather than guessed).
 *
 * Privacy notes:
 * - Removed runs are omitted, never re-introduced: no capsule or
 *   reconstruction geometry for the marked portion appears in the output.
 * - Miter spikes and butt-cap geometry at interior vertices are reproduced
 *   by the renderer from visible outside geometry; no extra coordinates for
 *   the marked region are emitted.
 * - ClipError messages describe structure only (operator names, depth
 *   limits) and never echo document content or coordinates.
 *
 * This module is engine-free on purpose: the mutation-boundary test
 * (adapter.test.ts) requires that only adapter.ts/save.ts/selfcheck.ts
 * import "mupdf". Form XObject recursion is delegated to the ClipHost,
 * implemented by the adapter.
 */

export class ClipError extends Error {
  constructor(message: string) {
    super(`vector-clip: ${message}`);
    this.name = "ClipError";
  }
}

/** Axis-aligned rectangle in PDF user space (y-up), ordered x0<x1, y0<y1. */
export interface ClipRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** PDF 6-number matrix [a b c d e f]: x' = a*x + c*y + e; y' = b*x + d*y + f. */
export interface ClipCtm {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/**
 * Adapter-provided bridge into the live document for Form XObjects.
 * Implemented by adapter.ts (the only redact-path module that may use mupdf).
 */
export interface ClipHost {
  /**
   * The form's /Matrix (default identity) when `name` resolves to a Form
   * XObject in the current resource scope; null otherwise (images, etc.).
   * Throws ClipError when the reference is malformed.
   */
  formMatrix(name: string): ClipCtm | null;
  /**
   * Recursively clip the named form's content stream under the composed CTM
   * (parent CTM composed with the form matrix). Throws ClipError on any
   * failure; a form whose stream needs no change is left untouched.
   */
  clipForm(name: string, ctm: ClipCtm): void;
}

export interface ClipOptions {
  /** Mark rectangles in PDF user space (y-up), in application order. */
  readonly marks: readonly ClipRect[];
  /** CTM mapping this stream's local coordinates to user space. */
  readonly ctm: ClipCtm;
  readonly host: ClipHost;
}

/** Shortest PDF-safe decimal for a computed value (no exponents allowed). */
function fmt(n: number): string {
  if (!Number.isFinite(n)) throw new ClipError("non-finite computed value");
  let s = n.toFixed(6).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s;
}

const PARTITION_DEPTH = 10;
/** Max bezier subdivision depth for the stroke touch test. */
const TOUCH_DEPTH = 12;

function isWs(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\0";
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { k: "num"; v: number; lex: string; s: number; e: number }
  | { k: "name"; v: string; s: number; e: number }
  | { k: "str"; s: number; e: number }
  | { k: "arrS"; s: number; e: number }
  | { k: "arrE"; s: number; e: number }
  | { k: "dictS"; s: number; e: number }
  | { k: "dictE"; s: number; e: number }
  | { k: "op"; name: string; s: number; e: number }
  | { k: "inline"; s: number; e: number }; // whole BI..EI block, verbatim

const OPERATORS: ReadonlySet<string> = new Set([
  "q", "Q", "cm", "w", "J", "j", "M", "d", "ri", "i", "gs",
  "m", "l", "c", "v", "y", "h", "re",
  "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n", "W", "W*", "sh",
  "BT", "ET", "Tc", "Td", "TD", "Tf", "Tj", "TJ", "TL", "Tm", "Tr", "Ts", "Tw", "Tz", "T*", "'", '"',
  "Do",
  "BMC", "BDC", "EMC", "MP", "DP",
  "BX", "EX",
  "cs", "CS", "sc", "scn", "SCN", "g", "G", "rg", "RG", "k", "K",
  "BI", "ID", "EI",
]);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  let sawBI = false;
  while (i < n) {
    const ch = src[i]!;
    if (isWs(ch)) { i++; continue; }
    if (ch === "%") {
      while (i < n && src[i] !== "\n" && src[i] !== "\r") i++;
      continue;
    }
    if (ch === "(") {
      let j = i + 1;
      let depth = 1;
      while (j < n && depth > 0) {
        const c = src[j]!;
        if (c === "\\") { j += 2; continue; }
        if (c === "(") depth++;
        else if (c === ")") depth--;
        j++;
      }
      if (depth !== 0) throw new ClipError("unterminated string");
      toks.push({ k: "str", s: i, e: j });
      i = j;
      continue;
    }
    if (ch === "<") {
      if (src[i + 1] === "<") { toks.push({ k: "dictS", s: i, e: i + 2 }); i += 2; continue; }
      let j = i + 1;
      while (j < n && src[j] !== ">") j++;
      if (j >= n) throw new ClipError("unterminated hex string");
      toks.push({ k: "str", s: i, e: j + 1 });
      i = j + 1;
      continue;
    }
    if (ch === ">") {
      if (src[i + 1] === ">") { toks.push({ k: "dictE", s: i, e: i + 2 }); i += 2; continue; }
      throw new ClipError("stray >");
    }
    if (ch === "[") { toks.push({ k: "arrS", s: i, e: i + 1 }); i++; continue; }
    if (ch === "]") { toks.push({ k: "arrE", s: i, e: i + 1 }); i++; continue; }
    if (ch === "/") {
      let j = i + 1;
      while (j < n && !/[\s()\[\]<>{}%/]/.test(src[j]!)) {
        if (src[j] === "#") j += 3;
        else j++;
      }
      toks.push({ k: "name", v: src.slice(i + 1, j), s: i, e: j });
      i = j;
      continue;
    }
    if (/[A-Za-z'"]/.test(ch)) {
      let j = i + 1;
      if (ch !== "'" && ch !== '"') {
        while (j < n && /[A-Za-z0-9*']/.test(src[j]!)) j++;
      }
      const name = src.slice(i, j);
      if (!OPERATORS.has(name) && name !== "true" && name !== "false" && name !== "null") {
        throw new ClipError(`unsupported operator '${name}'`);
      }
      const tok: Tok = { k: "op", name, s: i, e: j };
      toks.push(tok);
      i = j;
      if (name === "BI") {
        sawBI = true;
      } else if (name === "ID" && sawBI) {
        // Inline image: the data runs from here to the first
        // whitespace-delimited EI. Fold BI..EI into one verbatim token.
        sawBI = false;
        let j2 = tok.e;
        if (j2 < n && isWs(src[j2])) j2++;
        let k = j2;
        let found = -1;
        while (k < n) {
          if (
            isWs(src[k]) &&
            src[k + 1] === "E" && src[k + 2] === "I" &&
            (k + 3 >= n || isWs(src[k + 3]))
          ) { found = k; break; }
          k++;
        }
        if (found < 0) throw new ClipError("inline image without terminator");
        // Remove BI..ID tokens (the image dictionary goes with the data).
        let biIdx = toks.length - 1;
        while (biIdx >= 0 && !(toks[biIdx]!.k === "op" && (toks[biIdx] as { name: string }).name === "BI")) biIdx--;
        if (biIdx < 0) throw new ClipError("inline image without begin marker");
        const biStart = toks[biIdx]!.s;
        toks.length = biIdx;
        toks.push({ k: "inline", s: biStart, e: found + 3 });
        i = found + 3;
      } else {
        sawBI = false;
      }
      continue;
    }
    const nm = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (nm) {
      const lex = nm[0]!;
      toks.push({ k: "num", v: parseFloat(lex), lex, s: i, e: i + lex.length });
      i += lex.length;
      continue;
    }
    throw new ClipError("unexpected byte in content stream");
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Operator model
// ---------------------------------------------------------------------------

interface Op {
  name: string;
  args: Tok[];
  start: number;
  end: number;
}

function parseOps(toks: Tok[]): Op[] {
  const ops: Op[] = [];
  let args: Tok[] = [];
  for (const t of toks) {
    if (t.k === "inline") {
      // A BI..EI block always starts a new object; operands before it are
      // malformed.
      if (args.length > 0) throw new ClipError("operands before inline image");
      ops.push({ name: "__inline__", args: [], start: t.s, end: t.e });
    } else if (t.k === "op" && OPERATORS.has(t.name)) {
      const start = args.length > 0 ? args[0]!.s : t.s;
      ops.push({ name: t.name, args, start, end: t.e });
      args = [];
    } else {
      args.push(t);
    }
  }
  if (args.length > 0) throw new ClipError("trailing operands without operator");
  return ops;
}

function numTok(t: Tok | undefined, what: string): { v: number; lex: string } {
  if (!t || t.k !== "num") throw new ClipError(`expected number operand for ${what}`);
  return { v: t.v, lex: t.lex };
}

function nameTok(t: Tok | undefined, what: string): string {
  if (!t || t.k !== "name") throw new ClipError(`expected name operand for ${what}`);
  return t.v;
}

// ---------------------------------------------------------------------------
// Geometry (stream-local space)
// ---------------------------------------------------------------------------

interface Pt {
  x: number;
  y: number;
  /** Original lexeme when this point came straight from the stream. */
  lx?: string;
  ly?: string;
}

function ptLex(p: Pt): string {
  return `${p.lx ?? fmt(p.x)} ${p.ly ?? fmt(p.y)}`;
}

function distPtRectStrictInside(px: number, py: number, r: ClipRect): boolean {
  return px > r.x0 && px < r.x1 && py > r.y0 && py < r.y1;
}

function dist2SegPoint(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

function segSegDist(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number {
  // Proper intersection test first.
  const d1x = bx - ax;
  const d1y = by - ay;
  const d2x = dx - cx;
  const d2y = dy - cy;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) > 1e-18) {
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom;
    const u = ((cx - ax) * d1y - (cy - ay) * d1x) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    dist2SegPoint(cx, cy, dx, dy, ax, ay),
    dist2SegPoint(cx, cy, dx, dy, bx, by),
    dist2SegPoint(ax, ay, bx, by, cx, cy),
    dist2SegPoint(ax, ay, bx, by, dx, dy),
  );
}

/** Distance from segment ab to the closed rectangle (0 when touching). */
function segRectDistClosed(
  ax: number, ay: number, bx: number, by: number, r: ClipRect,
): number {
  if (ax >= r.x0 && ax <= r.x1 && ay >= r.y0 && ay <= r.y1) return 0;
  if (bx >= r.x0 && bx <= r.x1 && by >= r.y0 && by <= r.y1) return 0;
  let d = Infinity;
  d = Math.min(d, segSegDist(ax, ay, bx, by, r.x0, r.y0, r.x1, r.y0));
  d = Math.min(d, segSegDist(ax, ay, bx, by, r.x1, r.y0, r.x1, r.y1));
  d = Math.min(d, segSegDist(ax, ay, bx, by, r.x1, r.y1, r.x0, r.y1));
  d = Math.min(d, segSegDist(ax, ay, bx, by, r.x0, r.y1, r.x0, r.y0));
  return d;
}

function ptRectDistClosed(px: number, py: number, r: ClipRect): number {
  const dx = px < r.x0 ? r.x0 - px : px > r.x1 ? px - r.x1 : 0;
  const dy = py < r.y0 ? r.y0 - py : py > r.y1 ? py - r.y1 : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Liang-Barsky clip of segment ab against the closed rect.
 * Returns the inside t-interval, or null when there is none.
 */
function liangBarskyClosed(
  ax: number, ay: number, bx: number, by: number, r: ClipRect,
): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const edges: Array<[number, number]> = [
    [-dx, ax - r.x0],
    [dx, r.x1 - ax],
    [-dy, ay - r.y0],
    [dy, r.y1 - ay],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-18) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/**
 * True when the segment lies on one of the rect's edge lines and overlaps
 * the edge span. Such boundary-collinear strokes are kept (their paint is
 * the stroke's own, half outside the mark; removing them would destroy
 * visible content while the inside half is covered by the opaque fill).
 */
function collinearWithRectEdge(
  ax: number, ay: number, bx: number, by: number, r: ClipRect,
): boolean {
  const edges: Array<[number, number, number, number]> = [
    [r.x0, r.y0, r.x1, r.y0],
    [r.x1, r.y0, r.x1, r.y1],
    [r.x1, r.y1, r.x0, r.y1],
    [r.x0, r.y1, r.x0, r.y0],
  ];
  for (const [ex0, ey0, ex1, ey1] of edges) {
    const dx = ex1 - ex0;
    const dy = ey1 - ey0;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const tol = 1e-9 * len;
    const c1 = dx * (ay - ey0) - dy * (ax - ex0);
    const c2 = dx * (by - ey0) - dy * (bx - ex0);
    if (Math.abs(c1) > tol || Math.abs(c2) > tol) continue;
    const ta = ((ax - ex0) * dx + (ay - ey0) * dy) / len;
    const tb = ((bx - ex0) * dx + (by - ey0) * dy) / len;
    const lo = Math.max(Math.min(ta, tb), 0);
    const hi = Math.min(Math.max(ta, tb), len);
    if (hi > lo + 1e-12) return true;
  }
  return false;
}

/** Compose parent CTM with a nested matrix: result(p) = parent(m(p)). */
export function composeCtm(parent: ClipCtm, m: ClipCtm): ClipCtm {
  return {
    a: parent.a * m.a + parent.c * m.b,
    b: parent.b * m.a + parent.d * m.b,
    c: parent.a * m.c + parent.c * m.d,
    d: parent.b * m.c + parent.d * m.d,
    e: parent.a * m.e + parent.c * m.f + parent.e,
    f: parent.b * m.e + parent.d * m.f + parent.f,
  };
}

/**
 * Map user-space marks into stream-local space. Only uniform axis-aligned
 * scale+translate CTMs are supported: anything else cannot be clipped
 * exactly, so the caller fails closed.
 */
function toLocalMarks(ctm: ClipCtm, marks: readonly ClipRect[]): ClipRect[] {
  const { a, b, c, d, e, f } = ctm;
  for (const v of [a, b, c, d, e, f]) {
    if (!Number.isFinite(v)) throw new ClipError("non-finite CTM");
  }
  if (Math.abs(b) > 1e-12 || Math.abs(c) > 1e-12) {
    throw new ClipError("rotated or skewed CTM cannot be clipped exactly");
  }
  if (a === 0 || d === 0) throw new ClipError("singular CTM");
  const rel = Math.abs(Math.abs(a) - Math.abs(d)) / Math.max(Math.abs(a), Math.abs(d));
  if (rel > 1e-9) throw new ClipError("non-uniform CTM scale cannot be clipped exactly");
  return marks.map((m) => {
    for (const v of [m.x0, m.y0, m.x1, m.y1]) {
      if (!Number.isFinite(v)) throw new ClipError("non-finite mark");
    }
    if (!(m.x0 < m.x1 && m.y0 < m.y1)) throw new ClipError("mark not ordered");
    const x0 = (m.x0 - e) / a;
    const x1 = (m.x1 - e) / a;
    const y0 = (m.y0 - f) / d;
    const y1 = (m.y1 - f) / d;
    return {
      x0: Math.min(x0, x1),
      y0: Math.min(y0, y1),
      x1: Math.max(x0, x1),
      y1: Math.max(y0, y1),
    };
  });
}

/** Convex hull of up to 4 points (Andrew's monotone chain). */
function convexHull(points: Pt[]): Pt[] {
  const sorted = [...points].sort((p, q) => (p.x - q.x) || (p.y - q.y));
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function pointInConvexPolyStrict(px: number, py: number, hull: Pt[]): boolean {
  // All cross products must have the same strict sign.
  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const c = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    if (Math.abs(c) < 1e-15) return false;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return hull.length > 0;
}

/** True when the segment meets the rect's strict interior. */
function segHitsRectInterior(
  ax: number, ay: number, bx: number, by: number, r: ClipRect,
): boolean {
  if (distPtRectStrictInside(ax, ay, r) || distPtRectStrictInside(bx, by, r)) return true;
  const iv = liangBarskyClosed(ax, ay, bx, by, r);
  if (!iv) return false;
  const [t0, t1] = iv;
  if (t1 - t0 < 1e-12) return false; // touches the boundary at most
  const tm = (t0 + t1) / 2;
  return distPtRectStrictInside(ax + tm * (bx - ax), ay + tm * (by - ay), r);
}

/**
 * True when a convex polygon is disjoint from every rect's strict interior.
 * The curve is contained in its control hull, so disjointness is sound for
 * "the curve stays outside the mark".
 */
function hullDisjointFromMarks(hull: Pt[], marks: readonly ClipRect[]): boolean {
  if (hull.length === 0) return true;
  for (const r of marks) {
    for (const p of hull) {
      if (distPtRectStrictInside(p.x, p.y, r)) return false;
    }
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i]!;
      const b = hull[(i + 1) % hull.length]!;
      if (segHitsRectInterior(a.x, a.y, b.x, b.y, r)) return false;
    }
    for (const [cx, cy] of [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]] as const) {
      if (pointInConvexPolyStrict(cx, cy, hull)) return false;
    }
  }
  return true;
}

/** True when the convex polygon is fully inside some mark's strict interior. */
function hullInsideSomeMark(hull: Pt[], marks: readonly ClipRect[]): boolean {
  if (hull.length === 0) return false;
  return marks.some((r) => hull.every((p) => distPtRectStrictInside(p.x, p.y, r)));
}

// ---------------------------------------------------------------------------
// Path model and interpreter
// ---------------------------------------------------------------------------

type Seg =
  | { t: "l"; p: Pt }
  | { t: "c"; c1: Pt; c2: Pt; p: Pt };

interface Sub {
  start: Pt;
  segs: Seg[];
  closed: boolean;
}

interface GState {
  ctm: ClipCtm;
  lineWidth: number;
  lineCap: 0 | 1 | 2;
  lineJoin: 0 | 1 | 2;
  miterLimit: number;
  dashArrLex: string[];
  dashArr: number[];
  dashPhase: number;
  /** Verbatim stroking color text, e.g. "1 0 0 RG". */
  strokePaint: string;
  extGs: boolean;
}

type PaintKind = "stroke" | "fill" | "fillstroke";

interface PathPlan {
  start: number;
  end: number;
  kind: PaintKind;
  evenOdd: boolean;
  subs: Sub[];
  gs: GState;
}

function toFillPaint(strokePaint: string): string {
  const m = /(SCN|RG|CS|K|G)$/.exec(strokePaint.trim());
  if (!m) throw new ClipError("unrecognized paint operator");
  const map: Record<string, string> = { SCN: "scn", RG: "rg", CS: "cs", K: "k", G: "g" };
  return strokePaint.trim().slice(0, -m[1]!.length) + map[m[1]!]!;
}

function freshGState(): GState {
  return {
    ctm: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    lineWidth: 1,
    lineCap: 0,
    lineJoin: 0,
    miterLimit: 10,
    dashArrLex: [],
    dashArr: [],
    dashPhase: 0,
    strokePaint: "0 G",
    extGs: false,
  };
}

function checkIntTok(t: { v: number }, what: string, allowed: readonly number[]): 0 | 1 | 2 {
  if (!Number.isInteger(t.v) || !allowed.includes(t.v)) {
    throw new ClipError(`invalid ${what}`);
  }
  return t.v as 0 | 1 | 2;
}

interface InterpResult {
  plans: PathPlan[];
}

function interpret(ops: Op[], opts: ClipOptions): InterpResult {
  const plans: PathPlan[] = [];
  const gsStack: GState[] = [];
  let gs = freshGState();
  let textDepth = 0;
  let compatDepth = 0;

  // Active path construction.
  let active = false;
  let pathStart = 0;
  let dirty = false;
  let hasClipOp = false;
  let subs: Sub[] = [];
  let cur: { start: Pt; segs: Seg[] } | null = null;

  const pushSub = (): void => {
    if (cur) {
      subs.push({ start: cur.start, segs: cur.segs, closed: false });
      cur = null;
    }
  };
  const needActive = (op: Op, what: string): void => {
    if (textDepth > 0) throw new ClipError(`${what} inside text object`);
    if (!active) {
      active = true;
      pathStart = op.start;
      dirty = false;
      hasClipOp = false;
      subs = [];
      cur = null;
    }
  };
  const curPt = (): Pt => {
    if (!cur) throw new ClipError("path segment without current point");
    const segs = cur.segs;
    return segs.length > 0 ? segs[segs.length - 1]!.p : cur.start;
  };
  const markDirtyIfActive = (): void => {
    if (active) dirty = true;
  };

  const finishPath = (op: Op, kind: PaintKind, evenOdd: boolean): void => {
    pushSub();
    plans.push({
      start: pathStart,
      end: op.end,
      kind,
      evenOdd,
      subs,
      gs: { ...gs, ctm: { ...gs.ctm } },
    });
    active = false;
    subs = [];
    cur = null;
  };

  const discardPath = (): void => {
    active = false;
    subs = [];
    cur = null;
  };

  for (const op of ops) {
    const a = op.args;
    switch (op.name) {
      case "q":
        if (a.length !== 0) throw new ClipError("q takes no operands");
        markDirtyIfActive();
        gsStack.push(gs);
        gs = { ...gs, ctm: { ...gs.ctm } };
        break;
      case "Q":
        if (a.length !== 0) throw new ClipError("Q takes no operands");
        markDirtyIfActive();
        {
          const prev = gsStack.pop();
          if (!prev) throw new ClipError("unbalanced Q");
          gs = prev;
        }
        break;
      case "cm": {
        if (a.length !== 6) throw new ClipError("cm arity");
        const [ma, mb, mc, md, me, mf] = a.map((t) => numTok(t, "cm").v);
        markDirtyIfActive();
        gs.ctm = composeCtm({ a: ma!, b: mb!, c: mc!, d: md!, e: me!, f: mf! }, gs.ctm);
        break;
      }
      case "w": {
        if (a.length !== 1) throw new ClipError("w arity");
        const w = numTok(a[0], "w").v;
        if (w < 0 || !Number.isFinite(w)) throw new ClipError("invalid line width");
        gs.lineWidth = w;
        break;
      }
      case "J":
        if (a.length !== 1) throw new ClipError("J arity");
        gs.lineCap = checkIntTok(numTok(a[0], "J"), "line cap", [0, 1, 2]);
        break;
      case "j":
        if (a.length !== 1) throw new ClipError("j arity");
        gs.lineJoin = checkIntTok(numTok(a[0], "j"), "line join", [0, 1, 2]);
        break;
      case "M": {
        if (a.length !== 1) throw new ClipError("M arity");
        const m = numTok(a[0], "M").v;
        if (!(m > 0) || !Number.isFinite(m)) throw new ClipError("invalid miter limit");
        gs.miterLimit = m;
        break;
      }
      case "d": {
        if (a.length < 3) throw new ClipError("d arity");
        const open = a[0]!;
        const close = a[a.length - 2]!;
        const phaseT = a[a.length - 1]!;
        if (open.k !== "arrS" || close.k !== "arrE") throw new ClipError("d dash array");
        const vals: number[] = [];
        const lex: string[] = [];
        for (const t of a.slice(1, -2)) {
          const n = numTok(t, "d");
          if (!(n.v >= 0) || !Number.isFinite(n.v)) throw new ClipError("invalid dash element");
          vals.push(n.v);
          lex.push(n.lex);
        }
        const phase = numTok(phaseT, "d").v;
        if (!Number.isFinite(phase)) throw new ClipError("invalid dash phase");
        gs.dashArr = vals;
        gs.dashArrLex = lex;
        gs.dashPhase = phase;
        break;
      }
      case "ri":
      case "i":
        if (a.length !== 1) throw new ClipError(`${op.name} arity`);
        break; // rendering intent / flatness: no geometric effect on the rewrite
      case "gs":
        if (a.length !== 1) throw new ClipError("gs arity");
        nameTok(a[0], "gs");
        gs.extGs = true;
        break;
      case "G":
      case "RG":
      case "K": {
        const want = { G: 1, RG: 3, K: 4 }[op.name]!;
        if (a.length !== want) throw new ClipError(`${op.name} arity`);
        const parts = a.map((t) => {
          const n = numTok(t, op.name);
          if (!Number.isFinite(n.v)) throw new ClipError("invalid color component");
          return n.lex;
        });
        gs.strokePaint = `${parts.join(" ")} ${op.name}`;
        break;
      }
      case "g":
      case "rg":
      case "k": {
        // Non-stroking color: validated but not tracked (see cs).
        const want = { g: 1, rg: 3, k: 4 }[op.name]!;
        if (a.length !== want) throw new ClipError(`${op.name} arity`);
        for (const t of a) numTok(t, op.name);
        break;
      }
      case "CS": {
        if (a.length !== 1) throw new ClipError("CS arity");
        const nm = nameTok(a[0], "CS");
        gs.strokePaint = `/${nm} CS`;
        break;
      }
      case "cs": {
        // Non-stroking colorspace: no effect on stroke paint. Fill-only
        // paths never need their paint replayed (verbatim or removed), so
        // the non-stroking color is validated but not tracked.
        if (a.length !== 1) throw new ClipError("cs arity");
        nameTok(a[0], "cs");
        break;
      }
      case "SCN": {
        const parts = a.map((t) => {
          if (t.k === "num") return t.lex;
          if (t.k === "name") return `/${t.v}`;
          throw new ClipError("SCN operand");
        });
        const cs = gs.strokePaint.trim();
        const csPart = /CS$/.test(cs) ? `${cs} ` : "";
        gs.strokePaint = `${csPart}${parts.join(" ")} SCN`;
        break;
      }
      case "scn": {
        // Non-stroking color: validated but not tracked (see cs).
        for (const t of a) {
          if (t.k !== "num" && t.k !== "name") throw new ClipError("scn operand");
        }
        break;
      }
      case "sc": {
        // Non-stroking color: validated but not tracked (see cs).
        for (const t of a) {
          if (t.k !== "num" && t.k !== "name") throw new ClipError("sc operand");
        }
        break;
      }
      case "m": {
        if (a.length !== 2) throw new ClipError("m arity");
        needActive(op, "m");
        const x = numTok(a[0], "m");
        const x1 = numTok(a[1], "m");
        pushSub();
        cur = { start: { x: x.v, y: x1.v, lx: x.lex, ly: x1.lex }, segs: [] };
        break;
      }
      case "l": {
        if (a.length !== 2) throw new ClipError("l arity");
        needActive(op, "l");
        const x = numTok(a[0], "l");
        const y = numTok(a[1], "l");
        curPt();
        cur!.segs.push({ t: "l", p: { x: x.v, y: y.v, lx: x.lex, ly: y.lex } });
        break;
      }
      case "c": {
        if (a.length !== 6) throw new ClipError("c arity");
        needActive(op, "c");
        const [x1, y1, x2, y2, x3, y3] = a.map((t) => numTok(t, "c"));
        curPt();
        cur!.segs.push({
          t: "c",
          c1: { x: x1!.v, y: y1!.v, lx: x1!.lex, ly: y1!.lex },
          c2: { x: x2!.v, y: y2!.v, lx: x2!.lex, ly: y2!.lex },
          p: { x: x3!.v, y: y3!.v, lx: x3!.lex, ly: y3!.lex },
        });
        break;
      }
      case "v":
      case "y": {
        if (a.length !== 4) throw new ClipError(`${op.name} arity`);
        needActive(op, op.name);
        const p0 = curPt();
        const [xa, ya, xb, yb] = a.map((t) => numTok(t, op.name));
        if (op.name === "v") {
          cur!.segs.push({
            t: "c",
            c1: { ...p0 },
            c2: { x: xa!.v, y: ya!.v, lx: xa!.lex, ly: ya!.lex },
            p: { x: xb!.v, y: yb!.v, lx: xb!.lex, ly: yb!.lex },
          });
        } else {
          cur!.segs.push({
            t: "c",
            c1: { x: xa!.v, y: ya!.v, lx: xa!.lex, ly: ya!.lex },
            c2: { x: xb!.v, y: yb!.v, lx: xb!.lex, ly: yb!.lex },
            p: { ...p0 },
          });
        }
        break;
      }
      case "h": {
        if (a.length !== 0) throw new ClipError("h arity");
        needActive(op, "h");
        pushSub();
        const last = subs[subs.length - 1];
        if (!last) throw new ClipError("h without a current subpath");
        last.closed = true;
        break;
      }
      case "re": {
        if (a.length !== 4) throw new ClipError("re arity");
        needActive(op, "re");
        const [x, y, w, h] = a.map((t) => numTok(t, "re").v);
        pushSub();
        const p = (px: number, py: number): Pt => ({ x: px, y: py });
        subs.push({
          start: p(x!, y!),
          segs: [
            { t: "l", p: p(x! + w!, y!) },
            { t: "l", p: p(x! + w!, y! + h!) },
            { t: "l", p: p(x!, y! + h!) },
          ],
          closed: true,
        });
        break;
      }
      case "S":
        if (a.length !== 0) throw new ClipError("S arity");
        if (textDepth > 0) throw new ClipError("S inside text object");
        if (active) {
          if (dirty || hasClipOp) return failDirty();
          finishPath(op, "stroke", false);
        }
        break;
      case "s":
        if (a.length !== 0) throw new ClipError("s arity");
        if (textDepth > 0) throw new ClipError("s inside text object");
        if (active) {
          if (dirty || hasClipOp) return failDirty();
          pushSub();
          const last = subs[subs.length - 1];
          if (!last) throw new ClipError("s without a current subpath");
          last.closed = true;
          finishPath(op, "stroke", false);
        }
        break;
      case "f":
      case "F":
      case "f*":
        if (a.length !== 0) throw new ClipError(`${op.name} arity`);
        if (textDepth > 0) throw new ClipError(`${op.name} inside text object`);
        if (active) {
          if (dirty || hasClipOp) return failDirty();
          finishPath(op, "fill", op.name === "f*");
        }
        break;
      case "B":
      case "B*":
      case "b":
      case "b*": {
        if (a.length !== 0) throw new ClipError(`${op.name} arity`);
        if (textDepth > 0) throw new ClipError(`${op.name} inside text object`);
        if (active) {
          if (dirty || hasClipOp) return failDirty();
          const close = op.name === "b" || op.name === "b*";
          if (close) {
            pushSub();
            const last = subs[subs.length - 1];
            if (last) last.closed = true;
          }
          finishPath(op, "fillstroke", op.name === "B*" || op.name === "b*");
        }
        break;
      }
      case "n":
        if (a.length !== 0) throw new ClipError("n arity");
        discardPath();
        break;
      case "W":
      case "W*":
        if (a.length !== 0) throw new ClipError(`${op.name} arity`);
        if (active) hasClipOp = true;
        else throw new ClipError("clip operator without a path");
        break;
      case "sh":
        if (a.length !== 1) throw new ClipError("sh arity");
        nameTok(a[0], "sh");
        discardPath();
        break;
      case "Do": {
        if (a.length !== 1) throw new ClipError("Do arity");
        const name = nameTok(a[0], "Do");
        if (active) {
          dirty = true; // handled at paint time via failDirty
        } else {
          let m: ClipCtm | null;
          try {
            m = opts.host.formMatrix(name);
          } catch (e) {
            throw e instanceof ClipError ? e : new ClipError("form lookup failed");
          }
          if (m) {
            const child = composeCtm(gs.ctm, m);
            try {
              opts.host.clipForm(name, child);
            } catch (e) {
              throw e instanceof ClipError ? e : new ClipError("form recursion failed");
            }
          }
        }
        break;
      }
      case "BT":
        if (a.length !== 0) throw new ClipError("BT arity");
        markDirtyIfActive();
        textDepth++;
        break;
      case "ET":
        if (a.length !== 0) throw new ClipError("ET arity");
        markDirtyIfActive();
        textDepth--;
        if (textDepth < 0) throw new ClipError("unbalanced ET");
        break;
      case "BMC":
        if (a.length !== 1) throw new ClipError("BMC arity");
        nameTok(a[0], "BMC");
        markDirtyIfActive();
        break;
      case "BDC":
      case "DP": {
        if (a.length !== 2) throw new ClipError(`${op.name} arity`);
        nameTok(a[0], op.name);
        markDirtyIfActive();
        break;
      }
      case "EMC":
        if (a.length !== 0) throw new ClipError("EMC arity");
        markDirtyIfActive();
        break;
      case "MP":
        if (a.length !== 1) throw new ClipError("MP arity");
        nameTok(a[0], "MP");
        markDirtyIfActive();
        break;
      case "BX":
      case "EX":
        if (a.length !== 0) throw new ClipError(`${op.name} arity`);
        markDirtyIfActive();
        compatDepth += op.name === "BX" ? 1 : -1;
        if (compatDepth < 0) throw new ClipError("unbalanced EX");
        break;
      case "__inline__":
        // Verbatim BI..EI block. Inside path construction it interrupts the
        // path, so a painted path containing one fails closed.
        markDirtyIfActive();
        break;
      default:
        // Tokenizer guarantees membership in OPERATORS; the remaining
        // operators (text positioning/showing, inline images) need no state.
        // Arity is not enforced for ignored ops: extra operands cannot
        // misalign parsing because operands are scoped per operator.
        if (textDepth < 0) throw new ClipError("unbalanced text object");
        break;
    }
  }
  if (active) throw new ClipError("unterminated path construction");
  if (textDepth !== 0) throw new ClipError("unbalanced text object");
  if (compatDepth !== 0) throw new ClipError("unbalanced compatibility section");
  if (gsStack.length !== 0) throw new ClipError("unbalanced graphics state");
  return { plans };

  function failDirty(): never {
    // A painted path whose construction was interrupted by operators this
    // rewrite cannot assess (Do/sh/inline image/marked content, q/Q/cm
    // mid-path, or a W clip). Failing closed: the marked portion cannot be
    // proven outside the mark.
    throw new ClipError("path construction interrupted by unhandled operator");
  }
}

// ---------------------------------------------------------------------------
// Touch tests
// ---------------------------------------------------------------------------

function subdivideCurve(p0: Pt, c1: Pt, c2: Pt, p3: Pt): [[Pt, Pt, Pt, Pt], [Pt, Pt, Pt, Pt]] {
  const m01 = midPt(p0, c1);
  const m12 = midPt(c1, c2);
  const m23 = midPt(c2, p3);
  const m012 = midPt(m01, m12);
  const m123 = midPt(m12, m23);
  const m0123 = midPt(m012, m123);
  return [
    [p0, m01, m012, m0123],
    [m0123, m123, m23, p3],
  ];
}

function midPt(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** All segments of a subpath, materializing the closing segment when closed. */
function walkSegs(sub: Sub): Array<{ a: Pt; b: Pt; seg: Seg | null }> {
  const out: Array<{ a: Pt; b: Pt; seg: Seg | null }> = [];
  let prev = sub.start;
  for (const sg of sub.segs) {
    out.push({ a: prev, b: sg.p, seg: sg });
    prev = sg.p;
  }
  if (sub.closed && sub.segs.length > 0) {
    out.push({ a: prev, b: sub.start, seg: null });
  }
  return out;
}

function curveStrokeTouched(
  p0: Pt, c1: Pt, c2: Pt, p3: Pt,
  r: number, marks: readonly ClipRect[], depth: number,
): boolean {
  const xs = [p0.x, c1.x, c2.x, p3.x];
  const ys = [p0.y, c1.y, c2.y, p3.y];
  const bx0 = Math.min(...xs) - r;
  const bx1 = Math.max(...xs) + r;
  const by0 = Math.min(...ys) - r;
  const by1 = Math.max(...ys) + r;
  let hit = false;
  for (const m of marks) {
    if (bx0 <= m.x1 && bx1 >= m.x0 && by0 <= m.y1 && by1 >= m.y0) {
      hit = true;
      break;
    }
  }
  if (!hit) return false;
  if (depth <= 0) return true;
  const [L, R] = subdivideCurve(p0, c1, c2, p3);
  return (
    curveStrokeTouched(L[0], L[1], L[2], L[3], r, marks, depth - 1) ||
    curveStrokeTouched(R[0], R[1], R[2], R[3], r, marks, depth - 1)
  );
}

/** True when the stroked centerline comes within r of any mark. */
function strokeTouched(subs: Sub[], r: number, marks: readonly ClipRect[]): boolean {
  const tol = r + 1e-9;
  for (const sub of subs) {
    if (sub.segs.length === 0) {
      for (const m of marks) {
        if (ptRectDistClosed(sub.start.x, sub.start.y, m) <= tol) return true;
      }
      continue;
    }
    for (const { a, b, seg } of walkSegs(sub)) {
      if (!seg || seg.t === "l") {
        for (const m of marks) {
          if (segRectDistClosed(a.x, a.y, b.x, b.y, m) <= tol) return true;
        }
      } else if (curveStrokeTouched(a, seg.c1, seg.c2, b, r, marks, TOUCH_DEPTH)) {
        return true;
      }
    }
  }
  return false;
}

function flattenCurveInto(p0: Pt, c1: Pt, c2: Pt, p3: Pt, out: Pt[], depth: number): void {
  const ux = 3 * c1.x - 2 * p0.x - p3.x;
  const uy = 3 * c1.y - 2 * p0.y - p3.y;
  const vx = 3 * c2.x - 2 * p3.x - p0.x;
  const vy = 3 * c2.y - 2 * p3.y - p0.y;
  if (depth <= 0 || (ux * ux + uy * uy < 0.0004 && vx * vx + vy * vy < 0.0004)) {
    out.push({ x: p3.x, y: p3.y });
    return;
  }
  const [L, R] = subdivideCurve(p0, c1, c2, p3);
  flattenCurveInto(L[0], L[1], L[2], L[3], out, depth - 1);
  flattenCurveInto(R[0], R[1], R[2], R[3], out, depth - 1);
}

function flattenSub(sub: Sub): Pt[] {
  const out: Pt[] = [{ x: sub.start.x, y: sub.start.y }];
  let prev = sub.start;
  for (const sg of sub.segs) {
    if (sg.t === "l") out.push({ x: sg.p.x, y: sg.p.y });
    else flattenCurveInto(prev, sg.c1, sg.c2, sg.p, out, 10);
    prev = sg.p;
  }
  if (sub.closed && sub.segs.length > 0) out.push({ x: sub.start.x, y: sub.start.y });
  return out;
}

function pointInFill(px: number, py: number, subs: Sub[], evenOdd: boolean): boolean {
  let inside = false;
  let winding = 0;
  for (const sub of subs) {
    const poly = flattenSub(sub);
    for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[i + 1]!;
      if (a.y > py !== b.y > py) {
        const xint = a.x + ((py - a.y) * (b.x - a.x)) / (b.y - a.y);
        if (xint > px) {
          if (evenOdd) inside = !inside;
          else winding += b.y > a.y ? 1 : -1;
        }
      }
    }
  }
  return evenOdd ? inside : winding !== 0;
}

/**
 * True when a fill is touched by a mark: its boundary comes within
 * edgeTol (stroke half-width plus a sub-pixel antialias margin) or the
 * fill covers any part of the mark.
 */
function fillTouched(
  subs: Sub[], marks: readonly ClipRect[], r: number, evenOdd: boolean,
): boolean {
  const tol = r + 0.75;
  for (const m of marks) {
    for (const sub of subs) {
      if (sub.segs.length === 0) {
        if (ptRectDistClosed(sub.start.x, sub.start.y, m) <= tol) return true;
        continue;
      }
      for (const { a, b, seg } of walkSegs(sub)) {
        if (!seg || seg.t === "l") {
          if (segRectDistClosed(a.x, a.y, b.x, b.y, m) <= tol) return true;
        } else if (curveStrokeTouched(a, seg.c1, seg.c2, b, tol, marks, TOUCH_DEPTH)) {
          return true;
        }
      }
      if (distPtRectStrictInside(sub.start.x, sub.start.y, m)) return true;
    }
    const cx = (m.x0 + m.x1) / 2;
    const cy = (m.y0 + m.y1) / 2;
    if (pointInFill(cx, cy, subs, evenOdd)) return true;
    const corners: ReadonlyArray<readonly [number, number]> = [
      [m.x0, m.y0], [m.x1, m.y0], [m.x1, m.y1], [m.x0, m.y1],
    ];
    for (const [px, py] of corners) {
      if (pointInFill(px, py, subs, evenOdd)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stroke partition: split subpaths into kept runs at mark boundaries
// ---------------------------------------------------------------------------

interface Leaf {
  keep: boolean;
  pts: [Pt, Pt, Pt, Pt];
  t0: number;
  t1: number;
}

/**
 * Partition a cubic bezier against the marks by conservative convex-hull
 * subdivision. A leaf is kept only when its control hull is disjoint from
 * every mark's strict interior (the curve lies inside its hull, so this is
 * sound); dropped when the hull is inside a mark, or when still ambiguous
 * at maximum depth (safe: the sliver lost is bounded by the hull slack of
 * a depth-10 piece, far below render resolution).
 */
function partitionCurve(
  p0: Pt, c1: Pt, c2: Pt, p3: Pt,
  marks: readonly ClipRect[], depth: number, t0: number, t1: number,
): Leaf[] {
  const hull = convexHull([p0, c1, c2, p3]);
  if (hullDisjointFromMarks(hull, marks)) {
    return [{ keep: true, pts: [p0, c1, c2, p3], t0, t1 }];
  }
  if (hullInsideSomeMark(hull, marks)) {
    return [{ keep: false, pts: [p0, c1, c2, p3], t0, t1 }];
  }
  if (depth <= 0) {
    return [{ keep: false, pts: [p0, c1, c2, p3], t0, t1 }];
  }
  const [L, R] = subdivideCurve(p0, c1, c2, p3);
  const tm = (t0 + t1) / 2;
  return [
    ...partitionCurve(L[0], L[1], L[2], L[3], marks, depth - 1, t0, tm),
    ...partitionCurve(R[0], R[1], R[2], R[3], marks, depth - 1, tm, t1),
  ];
}

function removedLineIntervals(a: Pt, b: Pt, marks: readonly ClipRect[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of marks) {
    if (collinearWithRectEdge(a.x, a.y, b.x, b.y, m)) continue;
    const iv = liangBarskyClosed(a.x, a.y, b.x, b.y, m);
    if (iv) out.push(iv);
  }
  return out;
}

function complementIntervals(removed: Array<[number, number]>): Array<[number, number]> {
  if (removed.length === 0) return [[0, 1]];
  const sorted = [...removed].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: Array<[number, number]> = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1] + 1e-12) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  const kept: Array<[number, number]> = [];
  let cur = 0;
  for (const [a, b] of merged) {
    if (a > cur + 1e-12) kept.push([cur, Math.min(a, 1)]);
    cur = Math.max(cur, b);
  }
  if (cur < 1 - 1e-12) kept.push([cur, 1]);
  return kept;
}

function curveSpeed(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): number {
  const mt = 1 - t;
  const dx =
    3 * mt * mt * (c1.x - p0.x) + 6 * mt * t * (c2.x - c1.x) + 3 * t * t * (p3.x - c2.x);
  const dy =
    3 * mt * mt * (c1.y - p0.y) + 6 * mt * t * (c2.y - c1.y) + 3 * t * t * (p3.y - c2.y);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Arc length of the bezier from 0 to t (Simpson, far below pixel error). */
function curveArcLength(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): number {
  if (t <= 0) return 0;
  const n = 64;
  const h = t / n;
  let sum = curveSpeed(p0, c1, c2, p3, 0) + curveSpeed(p0, c1, c2, p3, t);
  for (let i = 1; i < n; i++) {
    sum += (i % 2 === 0 ? 2 : 4) * curveSpeed(p0, c1, c2, p3, i * h);
  }
  return (sum * h) / 3;
}

interface KeptRun {
  start: Pt;
  cmds: string[];
  /** Arc length from the subpath start to this run's start (dash phase). */
  dashS: number;
  startAtSubStart: boolean;
  endAtSubEnd: boolean;
  endPt: Pt;
  degenerate: boolean;
}

interface RawPiece {
  emit: string;
  dashS: number;
  atStart: boolean;
  atEnd: boolean;
  startPt: Pt;
  endPt: Pt;
}

/**
 * Split one subpath's centerline at every mark boundary. Returns the kept
 * runs in order; removed runs are simply absent (their coordinates leave
 * the file). Runs are maximal so each becomes a single emitted subpath.
 */
function clipSubpath(sub: Sub, marks: readonly ClipRect[]): KeptRun[] {
  if (sub.segs.length === 0) {
    const inside = marks.some((m) => distPtRectStrictInside(sub.start.x, sub.start.y, m));
    if (inside) return [];
    return [{
      start: sub.start, cmds: [], dashS: 0,
      startAtSubStart: true, endAtSubEnd: true, endPt: sub.start, degenerate: true,
    }];
  }
  const pieces: RawPiece[] = [];
  const walked = walkSegs(sub);
  let s = 0;
  walked.forEach(({ a, b, seg }, i) => {
    const lastSeg = i === walked.length - 1;
    if (!seg || seg.t === "l") {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len > 0) {
        const kept = complementIntervals(removedLineIntervals(a, b, marks));
        for (const [t0, t1] of kept) {
          if ((t1 - t0) * len < 1e-12) continue;
          const pa = t0 === 0 ? a : lerpPt(a, b, t0);
          const pb = t1 === 1 ? b : lerpPt(a, b, t1);
          pieces.push({
            emit: `${ptLex(pb)} l`,
            dashS: s + t0 * len,
            atStart: s === 0 && t0 === 0,
            atEnd: lastSeg && t1 === 1,
            startPt: pa,
            endPt: pb,
          });
        }
      }
      s += len;
    } else {
      const leaves = partitionCurve(a, seg.c1, seg.c2, b, marks, PARTITION_DEPTH, 0, 1);
      const full = curveArcLength(a, seg.c1, seg.c2, b, 1);
      for (const lf of leaves) {
        if (!lf.keep) continue;
        const [p0, c1, c2, p3] = lf.pts;
        pieces.push({
          emit: `${ptLex(c1)} ${ptLex(c2)} ${ptLex(p3)} c`,
          dashS: s + curveArcLength(a, seg.c1, seg.c2, b, lf.t0),
          atStart: s === 0 && lf.t0 === 0,
          atEnd: lastSeg && lf.t1 === 1,
          startPt: p0,
          endPt: p3,
        });
      }
      s += full;
    }
  });

  const runs: KeptRun[] = [];
  for (const pc of pieces) {
    const lr = runs[runs.length - 1];
    if (lr && lr.endPt.x === pc.startPt.x && lr.endPt.y === pc.startPt.y) {
      lr.cmds.push(pc.emit);
      lr.endPt = pc.endPt;
      lr.endAtSubEnd = pc.atEnd;
    } else {
      runs.push({
        start: pc.startPt,
        cmds: [pc.emit],
        dashS: pc.dashS,
        startAtSubStart: pc.atStart,
        endAtSubEnd: pc.atEnd,
        endPt: pc.endPt,
        degenerate: false,
      });
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function dashPeriod(gs: GState): number {
  const sum = gs.dashArr.reduce((x, y) => x + y, 0);
  if (!(sum > 0)) return 0;
  return gs.dashArr.length % 2 === 1 ? sum * 2 : sum;
}

/** One kept run as its own path object: butt caps at cut ends, original join. */
function emitStrokeRun(run: KeptRun, gs: GState): string {
  const period = dashPeriod(gs);
  const phase = period === 0 ? 0 : (((gs.dashPhase + run.dashS) % period) + period) % period;
  let s = "q\n";
  s += `${fmt(gs.lineWidth)} w\n`;
  s += `0 J\n`;
  s += `${gs.lineJoin} j\n`;
  s += `${fmt(gs.miterLimit)} M\n`;
  s += `[${gs.dashArrLex.join(" ")}] ${fmt(phase)} d\n`;
  s += `${gs.strokePaint}\n`;
  s += `${ptLex(run.start)} m\n`;
  for (const c of run.cmds) s += `${c}\n`;
  s += `S\nQ\n`;
  return s;
}

function norm2(x: number, y: number): [number, number] | null {
  const l = Math.hypot(x, y);
  return l > 1e-18 ? [x / l, y / l] : null;
}

function curveEndTangent(sg: { c1: Pt; c2: Pt; p: Pt }, a: Pt, atStart: boolean): [number, number] | null {
  if (atStart) {
    return (
      norm2(sg.c1.x - a.x, sg.c1.y - a.y) ??
      norm2(sg.c2.x - a.x, sg.c2.y - a.y) ??
      norm2(sg.p.x - a.x, sg.p.y - a.y)
    );
  }
  return (
    norm2(sg.p.x - sg.c2.x, sg.p.y - sg.c2.y) ??
    norm2(sg.p.x - sg.c1.x, sg.p.y - sg.c1.y) ??
    norm2(sg.p.x - a.x, sg.p.y - a.y)
  );
}

function subpathEndTangent(sub: Sub, atStart: boolean): [number, number] | null {
  const segs = sub.segs;
  if (segs.length === 0) return null;
  if (atStart) {
    const sg = segs[0]!;
    if (sg.t === "l") return norm2(sg.p.x - sub.start.x, sg.p.y - sub.start.y);
    return curveEndTangent(sg, sub.start, true);
  }
  const sg = segs[segs.length - 1]!;
  const prev = segs.length > 1 ? segs[segs.length - 2]!.p : sub.start;
  if (sg.t === "l") return norm2(sg.p.x - prev.x, sg.p.y - prev.y);
  return curveEndTangent(sg, prev, false);
}

/**
 * Round/square caps at original subpath ends, as explicit filled shapes.
 * Cut ends keep butt caps (no new paint may cross into the mark). Closed
 * subpaths have no caps, matching the original rendering.
 */
function capShapes(runs: KeptRun[], sub: Sub, gs: GState): string {
  if (gs.lineCap === 0 || sub.closed) return "";
  const r = gs.lineWidth / 2;
  if (!(r > 0)) return "";
  let s = "";
  const disk = (c: Pt): void => {
    const k = 0.5522847498307936 * r;
    const { x, y } = c;
    s += `${fmt(x + r)} ${fmt(y)} m\n`;
    s += `${fmt(x + r)} ${fmt(y + k)} ${fmt(x + k)} ${fmt(y + r)} ${fmt(x)} ${fmt(y + r)} c\n`;
    s += `${fmt(x - k)} ${fmt(y + r)} ${fmt(x - r)} ${fmt(y + k)} ${fmt(x - r)} ${fmt(y)} c\n`;
    s += `${fmt(x - r)} ${fmt(y - k)} ${fmt(x - k)} ${fmt(y - r)} ${fmt(x)} ${fmt(y - r)} c\n`;
    s += `${fmt(x + k)} ${fmt(y - r)} ${fmt(x + r)} ${fmt(y - k)} ${fmt(x + r)} ${fmt(y)} c\n`;
  };
  const square = (c: Pt, t: [number, number]): void => {
    const nx = -t[1];
    const ny = t[0];
    const corners: Array<[number, number]> = [
      [c.x - r * nx, c.y - r * ny],
      [c.x + r * t[0] - r * nx, c.y + r * t[1] - r * ny],
      [c.x + r * t[0] + r * nx, c.y + r * t[1] + r * ny],
      [c.x + r * nx, c.y + r * ny],
    ];
    s += `${fmt(corners[0]![0])} ${fmt(corners[0]![1])} m\n`;
    for (let i = 1; i < 4; i++) s += `${fmt(corners[i]![0])} ${fmt(corners[i]![1])} l\n`;
    s += `h\n`;
  };
  const shapeAt = (p: Pt, atStart: boolean): void => {
    const t = subpathEndTangent(sub, atStart);
    if (!t) return;
    if (gs.lineCap === 1) disk(p);
    else square(p, atStart ? [-t[0], -t[1]] : t);
  };
  for (const run of runs) {
    if (run.degenerate) continue;
    if (run.startAtSubStart) shapeAt(run.start, true);
    if (run.endAtSubEnd) shapeAt(run.endPt, false);
  }
  return s;
}

function rewriteStroke(plan: PathPlan, marks: readonly ClipRect[]): string {
  let s = "";
  let shapes = "";
  for (const sub of plan.subs) {
    const runs = clipSubpath(sub, marks);
    for (const run of runs) s += emitStrokeRun(run, plan.gs);
    shapes += capShapes(runs, sub, plan.gs);
  }
  if (shapes !== "") {
    s += `q\n${toFillPaint(plan.gs.strokePaint)}\n${shapes}f\nQ\n`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Byte codec (true latin1 round-trip: bytes 0x80-0x9F must survive)
// ---------------------------------------------------------------------------

function bytesToLatin1(input: Uint8Array): string {
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < input.length; i += CHUNK) {
    s += String.fromCharCode(...input.subarray(i, i + CHUNK));
  }
  return s;
}

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

type Decision = "verbatim" | "remove" | "rewrite";

function decide(plan: PathPlan, marks: readonly ClipRect[], r: number): Decision {
  if (plan.gs.extGs) {
    // An external graphics state may alter stroke appearance arbitrarily;
    // pass through only when provably untouched.
    if (strokeTouched(plan.subs, r, marks)) {
      throw new ClipError("touched path under external graphics state");
    }
    return "verbatim";
  }
  switch (plan.kind) {
    case "stroke":
      return strokeTouched(plan.subs, r, marks) ? "rewrite" : "verbatim";
    case "fill":
      return fillTouched(plan.subs, marks, r, plan.evenOdd) ? "remove" : "verbatim";
    case "fillstroke":
      // A touched stroke implies a touched fill (the fill boundary contains
      // the centerline); both conditions are still checked independently.
      return strokeTouched(plan.subs, r, marks) ||
        fillTouched(plan.subs, marks, r, plan.evenOdd)
        ? "remove"
        : "verbatim";
  }
}

/**
 * Clip line art in one content stream against user-space marks.
 *
 * Returns null when the stream needs no change (byte-identical output is
 * then skipped by the caller); otherwise the rewritten stream bytes.
 * Throws ClipError when any path cannot be assessed or rewritten exactly —
 * the caller must fail the whole transform closed.
 */
export function clipLineArtInStream(
  input: Uint8Array,
  opts: ClipOptions,
): Uint8Array | null {
  if (opts.marks.length === 0) return null;
  // Validate the CTM before touching any state: an unsuitable matrix fails
  // closed even for streams that would otherwise pass through. (Per-path
  // cm operators are composed with this CTM in the loop below.)
  toLocalMarks(opts.ctm, opts.marks);

  const src = bytesToLatin1(input);
  const { plans } = interpret(parseOps(tokenize(src)), opts);
  if (plans.length === 0) return null;

  const rewrites: Array<{ start: number; end: number; text: string }> = [];
  for (const plan of plans) {
    // The path-level cm (if any) participates in the effective CTM: marks
    // are mapped into the path's own coordinate space and the composed
    // matrix must be a uniform axis-aligned scale+translate, otherwise the
    // path cannot be clipped exactly and the whole transform fails closed.
    // Stroke radius is in path-space units — the same space the geometry
    // and the mapped marks live in — so no scale factor applies.
    const localMarks = toLocalMarks(composeCtm(opts.ctm, plan.gs.ctm), opts.marks);
    const r = plan.gs.lineWidth / 2;
    const action = decide(plan, localMarks, r);
    if (action === "verbatim") continue;
    rewrites.push({
      start: plan.start,
      end: plan.end,
      text: action === "remove" ? "" : rewriteStroke(plan, localMarks),
    });
  }
  if (rewrites.length === 0) return null;

  let out = "";
  let pos = 0;
  for (const rw of rewrites) {
    out += src.slice(pos, rw.start);
    out += rw.text;
    pos = rw.end;
  }
  out += src.slice(pos);
  return latin1ToBytes(out);
}
