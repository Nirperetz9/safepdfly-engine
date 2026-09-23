/**
 * T094 — unit + property tests for the vector-crossing clip engine.
 *
 * Engine-free: every test operates on synthetic content-stream strings
 * through clipLineArtInStream (no mupdf). The core safety property —
 * no kept centerline segment ever enters a mark's strict interior — is
 * checked over 2000 seeded random line/mark pairs.
 */
import { describe, expect, it } from "vitest";
import {
  clipLineArtInStream,
  ClipError,
  composeCtm,
  type ClipCtm,
  type ClipHost,
  type ClipRect,
} from "./clip.js";

const IDENTITY: ClipCtm = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Host with no forms: Do of anything is a verbatim passthrough. */
const nullHost: ClipHost = {
  formMatrix: () => null,
  clipForm: () => {
    throw new ClipError("unexpected form clip");
  },
};

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function clip(
  src: string,
  marks: readonly ClipRect[],
  ctm: ClipCtm = IDENTITY,
  host: ClipHost = nullHost,
): string | null {
  const out = clipLineArtInStream(enc(src), { marks, ctm, host });
  return out === null ? null : new TextDecoder().decode(out);
}

function mark(x0: number, y0: number, x1: number, y1: number): ClipRect {
  return { x0, y0, x1, y1 };
}

/** Expect a ClipError; returns its message for content assertions. */
function throwsClip(
  src: string,
  marks: readonly ClipRect[],
  ctm: ClipCtm = IDENTITY,
  host: ClipHost = nullHost,
): string {
  try {
    clip(src, marks, ctm, host);
  } catch (e) {
    expect(e).toBeInstanceOf(ClipError);
    expect((e as Error).name).toBe("ClipError");
    return (e as Error).message;
  }
  throw new Error("expected ClipError, clipping succeeded");
}

const LINE = (x1: number, y1: number, x2: number, y2: number): string =>
  `0 0 0 RG\n${x1} ${y1} m ${x2} ${y2} l S\n`;

describe("passthrough (null = byte-identical, no rewrite)", () => {
  it("returns null for an untouched stroke", () => {
    expect(clip(LINE(10, 10, 20, 10), [mark(40, 0, 60, 20)])).toBeNull();
  });

  it("returns null when there are no marks", () => {
    expect(clip(LINE(10, 10, 100, 10), [])).toBeNull();
  });

  it("returns null for text and non-paint operators", () => {
    expect(clip("BT /F1 12 Tf 14.4 TL ET\n", [mark(0, 0, 600, 800)])).toBeNull();
    expect(clip("1 0 0 1 0 0 cm\n", [mark(0, 0, 600, 800)])).toBeNull();
  });

  it("returns null for a discarded path (n)", () => {
    expect(clip("10 10 m 20 20 l n\n", [mark(0, 0, 600, 800)])).toBeNull();
  });

  it("passes an image Do through verbatim", () => {
    expect(clip("/Im1 Do\n", [mark(0, 0, 600, 800)])).toBeNull();
  });

  it("returns null for an untouched fill", () => {
    expect(clip("100 100 10 10 re f\n", [mark(0, 0, 10, 10)])).toBeNull();
  });

  it("passes a stroke under an external graphics state through when untouched", () => {
    expect(clip("/GS1 gs\n10 10 m 20 10 l S\n", [mark(40, 0, 60, 20)])).toBeNull();
  });
});

describe("stroke clipping", () => {
  it("clips a crossing line into two kept runs", () => {
    const out = clip(LINE(10, 10, 100, 10), [mark(40, 0, 60, 20)]);
    expect(out).not.toBeNull();
    expect(out).toContain("10 10 m\n40 10 l");
    expect(out).toContain("60 10 m\n100 10 l");
    expect(out).not.toContain("10 10 m 100 10 l"); // original uncut line gone
    expect(out).not.toContain("40 10 m\n60 10 l"); // removed middle gone
  });

  it("removes a fully covered stroke but keeps the rest of the stream", () => {
    const out = clip(
      `0 0 0 RG\n45 10 m 55 10 l S\n50 50 m 60 50 l S\n`,
      [mark(40, 0, 60, 20)],
    );
    expect(out).not.toBeNull();
    expect(out).not.toContain("45 10");
    expect(out).toContain("50 50 m 60 50 l S"); // untouched path verbatim
  });

  it("keeps a centerline exactly on the mark boundary", () => {
    // Distance-zero contact counts as touched, but there is no interior
    // interval to remove: the line survives (possibly re-emitted).
    const out = clip(LINE(10, 20, 100, 20), [mark(40, 0, 60, 20)]);
    expect(out).not.toBeNull();
    expect(out).toContain("10 20 m");
    expect(out).toContain("100 20 l");
  });

  it("clips a diagonal crossing", () => {
    const out = clip(LINE(0, 0, 100, 100), [mark(40, 40, 60, 60)]);
    expect(out).not.toBeNull();
    expect(out).toContain("0 0 m\n40 40 l");
    expect(out).toContain("60 60 m\n100 100 l");
    expect(out).not.toContain("40 40 m\n60 60 l");
  });

  it("clips under a path-level cm by composing it into the effective CTM", () => {
    // cm scales by 2: the path-space mark for user mark [40,0,60,30] is
    // [20,0,30,15], and the line at y=10 crosses its interior.
    const out = clip("2 0 0 2 0 0 cm\n" + LINE(10, 10, 100, 10), [
      mark(40, 0, 60, 30),
    ]);
    expect(out).not.toBeNull();
    expect(out).toContain("10 10 m\n20 10 l");
    expect(out).toContain("30 10 m\n100 10 l");
    expect(out).not.toContain("20 10 m\n30 10 l");
  });

  it("clips under a translated form CTM (opts.ctm)", () => {
    // Form placed at 2x scale: user-space mark [40,0,60,30] is [20,0,30,15]
    // in form space. Stroke radius stays in path-space units (no double
    // scaling): a line 0.6 outside the mark is untouched.
    const ctm: ClipCtm = { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 };
    const out = clip(LINE(10, 10, 100, 10), [mark(40, 0, 60, 30)], ctm);
    expect(out).not.toBeNull();
    expect(out).toContain("10 10 m\n20 10 l");
    expect(out).toContain("30 10 m\n100 10 l");
    expect(clip(LINE(10, 10.6, 100, 10.6), [mark(40, 0, 60, 20)], ctm)).toBeNull();
  });
});

describe("fills", () => {
  it("removes a touched fill entirely", () => {
    const out = clip("10 10 10 10 re f\n", [mark(12, 12, 30, 30)]);
    expect(out).not.toBeNull();
    expect(out).not.toContain("re");
  });

  it("removes a touched fill+stroke entirely", () => {
    const out = clip("10 10 10 10 re B\n", [mark(12, 12, 30, 30)]);
    expect(out).not.toBeNull();
    expect(out).not.toContain("re");
  });
});

describe("dashes and caps", () => {
  it("adjusts the dash phase per kept run", () => {
    // Dash [5 3] has period 8. Second kept run starts at arc length 60.
    const out = clip("[5 3] 0 d\n0 100 m 100 100 l S\n", [mark(41, 90, 60, 110)]);
    expect(out).not.toBeNull();
    expect(out).toContain("[5 3] 0 d"); // first run: unchanged phase
    expect(out).toContain("[5 3] 4 d"); // second run: (0 + 60) % 8
  });

  it("uses butt caps at cuts and restores round caps at original endpoints", () => {
    const out = clip("1 J\n10 10 m 100 10 l S\n", [mark(40, 0, 60, 20)]);
    expect(out).not.toBeNull();
    expect(out).toContain("0 J"); // kept runs are butt-capped
    // The restored round endpoint disks are bezier fills: a plain line
    // contributes no other curve ops.
    expect(out).toMatch(/ c\n/);
  });

  it("restores the non-stroking color correctly (g/rg/k do not leak into stroke paint)", () => {
    // rg sets the FILL color; the stroke stays black (0 G default).
    const out = clip("1 0 0 rg\n10 10 m 100 10 l S\n", [mark(40, 0, 60, 20)]);
    expect(out).not.toBeNull();
    expect(out).toContain("0 G");
    expect(out).not.toContain("1 0 0 rg\nS");
  });

  it("tracks the stroking SCN color for cap restoration", () => {
    const out = clip("1 J\n/CS1 CS\n1 0 0 SCN\n10 10 m 100 10 l S\n", [
      mark(40, 0, 60, 20),
    ]);
    expect(out).not.toBeNull();
    expect(out).toContain("/CS1 CS\n1 0 0 SCN");
  });
});

describe("curves", () => {
  it("clips a bezier crossing the mark", () => {
    const src = "10 10 m 40 60 60 -20 100 10 c S\n";
    const out = clip(src, [mark(40, 0, 60, 20)]);
    expect(out).not.toBeNull();
    expect(out).not.toBe(src);
    // Kept pieces are still beziers.
    expect(out).toMatch(/ c\n/);
  });
});

describe("fail-closed", () => {
  it("rejects a malformed stream (bad arity)", () => {
    expect(throwsClip("10 m\n", [mark(0, 0, 600, 800)])).toContain("vector-clip:");
  });

  it("rejects an unknown operator", () => {
    expect(throwsClip("10 10 m 20 20 l XYZ\n", [mark(0, 0, 600, 800)])).toContain(
      "vector-clip:",
    );
  });

  it("rejects unbalanced Q", () => {
    expect(throwsClip("Q\n", [mark(0, 0, 600, 800)])).toContain("vector-clip:");
  });

  it("rejects a path painted and used as a clip (W)", () => {
    expect(throwsClip("10 10 m 100 10 l W S\n", [mark(40, 0, 60, 20)])).toContain(
      "vector-clip:",
    );
  });

  it("rejects a touched path under an external graphics state", () => {
    expect(
      throwsClip("/GS1 gs\n10 10 m 100 10 l S\n", [mark(40, 0, 60, 20)]),
    ).toContain("vector-clip:");
  });

  it("rejects a path built across a cm", () => {
    expect(
      throwsClip("10 10 m 2 0 0 2 0 0 cm 100 10 l S\n", [mark(40, 0, 60, 20)]),
    ).toContain("vector-clip:");
  });

  it("rejects a rotated path-level cm (cannot clip exactly)", () => {
    expect(
      throwsClip("0 1 -1 0 0 0 cm\n" + LINE(10, 10, 100, 10), [mark(40, 0, 60, 20)]),
    ).toContain("vector-clip:");
  });

  it("rejects a rotated form CTM", () => {
    const ctm: ClipCtm = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 };
    expect(throwsClip(LINE(10, 10, 100, 10), [mark(40, 0, 60, 20)], ctm)).toContain(
      "vector-clip:",
    );
  });

  it("rejects a non-uniform form CTM", () => {
    const ctm: ClipCtm = { a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 };
    expect(throwsClip(LINE(10, 10, 100, 10), [mark(40, 0, 60, 20)], ctm)).toContain(
      "vector-clip:",
    );
  });
});

describe("composeCtm", () => {
  it("composes parent and child matrices in PDF order", () => {
    expect(
      composeCtm(
        { a: 1, b: 0, c: 0, d: 1, e: 100, f: 100 },
        { a: 2, b: 0, c: 0, d: 2, e: 10, f: 10 },
      ),
    ).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 110, f: 110 });
  });
});

describe("nested Form XObjects via ClipHost", () => {
  it("clips the form stream under the composed CTM", () => {
    const formStreams = new Map<string, string>([["F1", "0 0 m 50 0 l S\n"]]);
    const seen: Array<{ name: string; ctm: ClipCtm }> = [];
    const host: ClipHost = {
      formMatrix: (name) =>
        name === "F1" ? { a: 2, b: 0, c: 0, d: 2, e: 10, f: 10 } : null,
      clipForm: (name, ctm) => {
        seen.push({ name, ctm });
        const src = formStreams.get(name);
        if (src === undefined) throw new ClipError("missing form");
        const out = clipLineArtInStream(enc(src), {
          marks: [mark(140, 100, 160, 120)],
          ctm,
          host,
        });
        if (out !== null) formStreams.set(name, new TextDecoder().decode(out));
      },
    };
    // Page stream places F1 under a translation; the page stream itself
    // carries no paths, so it needs no rewrite (null) while the form is
    // clipped through the host.
    const out = clip("q\n1 0 0 1 100 100 cm\n/F1 Do\nQ\n", [mark(140, 100, 160, 120)], IDENTITY, host);
    expect(out).toBeNull();
    expect(seen).toHaveLength(1);
    // child = translate(100,100) x formMatrix(2x, +10,+10) = scale 2, +110,+110.
    expect(seen[0]!.ctm).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 110, f: 110 });
    // Form line (0,0)-(50,0) renders at (110,110)-(210,110); the page-space
    // mark [140,100,160,120] is [15,-5,25,5] in form space.
    const formOut = formStreams.get("F1")!;
    expect(formOut).toContain("0 0 m\n15 0 l");
    expect(formOut).toContain("25 0 m\n50 0 l");
    expect(formOut).not.toContain("15 0 m\n25 0 l");
  });

  it("a Do of a non-form XObject is left alone", () => {
    expect(clip("/Im1 Do\n", [mark(0, 0, 600, 800)])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Property test: no kept centerline segment may enter a mark's strict interior.
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f3 = (n: number): string => n.toFixed(3);

/** All m/l segments in emission order. */
function keptSegments(out: string): Array<[number, number, number, number]> {
  const segs: Array<[number, number, number, number]> = [];
  let cx = 0;
  let cy = 0;
  let have = false;
  const re = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+([ml])(?![A-Za-z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    const x = parseFloat(m[1]!);
    const y = parseFloat(m[2]!);
    if (m[3] === "m") {
      cx = x;
      cy = y;
      have = true;
    } else if (have) {
      segs.push([cx, cy, x, y]);
      cx = x;
      cy = y;
    }
  }
  return segs;
}

/**
 * True when the segment passes through the mark's STRICT interior
 * (boundary contact does not count). Liang-Barsky against the closed
 * rect, then a strict-inside midpoint test with float-noise epsilon.
 */
function segHitsOpenRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  m: ClipRect,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, ax - m.x0],
    [dx, m.x1 - ax],
    [-dy, ay - m.y0],
    [dy, m.y1 - ay],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-15) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  if (t1 - t0 < 1e-9) return false;
  const tm = (t0 + t1) / 2;
  const px = ax + tm * dx;
  const py = ay + tm * dy;
  // The clipper emits computed split points with 6 decimals, so a kept
  // endpoint exactly on a mark boundary can parse up to 0.5e-6 inside it.
  // Anything at or below 1e-6 is emission rounding, not a real incursion
  // (it sits under the opaque fill and has no pixel effect).
  const e = 1e-6;
  return px > m.x0 + e && px < m.x1 - e && py > m.y0 + e && py < m.y1 - e;
}

describe("property: kept geometry never enters a mark interior", () => {
  it("2000 seeded random line/mark pairs", () => {
    const rand = mulberry32(0x094094);
    let clipped = 0;
    for (let i = 0; i < 2000; i++) {
      const x1 = rand() * 200;
      const y1 = rand() * 200;
      const x2 = rand() * 200;
      const y2 = rand() * 200;
      if (Math.hypot(x2 - x1, y2 - y1) < 1e-6) continue;
      const mx0 = rand() * 160;
      const my0 = rand() * 160;
      const mk = mark(mx0, my0, mx0 + 10 + rand() * 40, my0 + 10 + rand() * 40);
      const src = `0 0 0 RG\n${f3(x1)} ${f3(y1)} m ${f3(x2)} ${f3(y2)} l S\n`;
      const out = clip(src, [mk]);
      if (out === null) continue;
      clipped++;
      for (const [ax, ay, bx, by] of keptSegments(out)) {
        expect(
          segHitsOpenRect(ax, ay, bx, by, mk),
          `iter ${i}: kept segment (${ax},${ay})-(${bx},${by}) enters mark ${JSON.stringify(mk)}`,
        ).toBe(false);
      }
    }
    // Sanity: a good share of the random pairs must actually clip.
    expect(clipped).toBeGreaterThan(200);
  });
});
