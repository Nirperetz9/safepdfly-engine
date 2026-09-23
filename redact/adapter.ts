/**
 * T059 — MuPDF.js engine adapter for the approved redaction policy.
 *
 * This module with save.ts and selfcheck.ts forms the mutation facade: the
 * ONLY places in the redact path that import "mupdf" (enforced by
 * adapter.test.ts). It applies the approved policy for every rectangle:
 *
 * - text: REDACT_TEXT_REMOVE — glyphs destroyed, not overlaid;
 * - images: REDACT_IMAGE_PIXELS — covered pixels replaced with the fill;
 * - line art (T094): touched vector strokes are CLIPPED at the mark
 *   boundary by a destructive content-stream rewrite (clip.ts) — only the
 *   marked portion of the geometry is removed; the outside portions are
 *   re-emitted with identical stroke state. MuPDF's own line-art pass runs
 *   with REDACT_LINE_ART_NONE so it cannot reintroduce whole-path removal.
 *   Fills touched by a mark are still removed whole (regions cannot be
 *   clipped without changing the region outside the mark);
 * - fill: black_boxes — the redacted area gets an opaque fill.
 *
 * Rectangles arrive as viewport points (origin top-left of the CropBox as
 * displayed, y down): exactly what PDFAnnotation.setRect() consumes
 * (validated empirically in Phase 1, T008). For the vector clip they are
 * projected to canonical PDF user space through the approved geometry core
 * (T024 viewportToPdf) — the same projection the verifier uses, so the
 * clip and the verification agree on where the mark is.
 *
 * There is no overlay fallback anywhere in this module: any failure throws,
 * and the worker boundary (T058) maps it to TRANSFORM_FAILED. The
 * application never downgrades to a cosmetic rectangle.
 */
import { PDFDocument, PDFPage, type PDFObject } from "mupdf";
import type { TransformBackend } from "./handler.js";
import type { TransformRect } from "./protocol.js";
import { saveCandidate } from "./save.js";
import { runSelfCheck } from "./selfcheck.js";
import {
  ClipError,
  clipLineArtInStream,
  type ClipCtm,
  type ClipHost,
  type ClipRect,
} from "./clip.js";
import { makePageContext, viewportToPdf } from "../geometry/transforms.js";
import type { PageIndex } from "../geometry/types.js";

/** Open a document from raw bytes. Throws on corrupt/encrypted input. */
function openPdfDocument(bytes: ArrayBuffer): PDFDocument {
  // PDFDocument.openDocument is inherited from Document; the cast reflects
  // that a PDF magic buffer opens as a PDF document (throws otherwise).
  return PDFDocument.openDocument(
    new Uint8Array(bytes),
    "application/pdf",
  ) as PDFDocument;
}

/**
 * Apply the approved redaction policy for every rectangle. Groups by page,
 * destructively clips touched vector strokes at the mark boundary (T094),
 * then creates one Redact annotation per rectangle and applies MuPDF's
 * destructive text/image pass. Throws without mutating the caller's bytes
 * on any invalid input.
 */
export function applyRedactionPolicy(
  doc: PDFDocument,
  rects: readonly TransformRect[],
): void {
  const pageCount = doc.countPages();
  const byPage = new Map<number, TransformRect[]>();
  for (const r of rects) {
    // Defense in depth: the protocol validated these, but the adapter never
    // trusts the boundary blindly. Messages carry no content, so a bare
    // error is safe.
    if (!Number.isInteger(r.page) || r.page < 0 || r.page >= pageCount) {
      throw new Error("redact: rect page out of range");
    }
    if (!(r.x0 < r.x1 && r.y0 < r.y1)) {
      throw new Error("redact: rect must be non-empty and ordered");
    }
    const list = byPage.get(r.page);
    if (list === undefined) byPage.set(r.page, [r]);
    else list.push(r);
  }

  for (const [pageNo, pageRects] of byPage) {
    const page: PDFPage = doc.loadPage(pageNo);
    // T094: clip touched strokes BEFORE MuPDF's own pass. Any path that
    // cannot be clipped exactly throws here — fail closed, no candidate.
    clipPageLineArt(page, pageRects);
    for (const rc of pageRects) {
      const annot = page.createAnnotation("Redact");
      annot.setRect([rc.x0, rc.y0, rc.x1, rc.y1]);
      annot.update();
    }
    page.applyRedactions(
      true, // black_boxes: opaque fill over the redacted area
      PDFPage.REDACT_IMAGE_PIXELS, // covered image pixels replaced
      PDFPage.REDACT_LINE_ART_NONE, // T094: vector clipping done above; MuPDF must not remove paths
      PDFPage.REDACT_TEXT_REMOVE, // glyphs destroyed
    );
  }
}

// ---------------------------------------------------------------------------
// T094 — vector-crossing clip-instead-of-remove (adapter side)
// ---------------------------------------------------------------------------

/** Identity CTM: page content streams map local coordinates to user space. */
const IDENTITY_CTM: ClipCtm = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Maximum Form XObject nesting before failing closed (cycle guard). */
const MAX_FORM_DEPTH = 16;

/** Per-page Form XObject recursion state. */
interface ClipVisit {
  /**
   * (object number, CTM) pairs already clipped. A form reused under the
   * same CTM is idempotent (re-clipping finds nothing to do); under a
   * different CTM it is clipped again, accumulating removals. The union
   * is privacy-safe: every placement loses at least the geometry its own
   * marks require. Over-removal, if any, fails closed at verification.
   */
  done: Set<string>;
  /** Object numbers on the current recursion stack: re-entry is a cycle. */
  active: Set<number>;
}

function ctmKey(ctm: ClipCtm): string {
  return `${ctm.a},${ctm.b},${ctm.c},${ctm.d},${ctm.e},${ctm.f}`;
}

/**
 * Project the page's viewport rects to canonical PDF user space (y-up)
 * through the approved geometry core — the same projection the verifier
 * derives its VerifyRects from, so clip and verification agree.
 */
/**
 * Raw (unrotated) page box in PDF user space. MuPDF's getBounds() returns
 * rotation-applied bounds, but the clip rewrites the content stream, which
 * lives in unrotated user space — so the box must come from the page
 * dictionary (CropBox, defaulting to MediaBox per the PDF spec).
 */
function rawPageBox(obj: PDFObject): [number, number, number, number] {
  const crop = obj.getInheritable("CropBox");
  const arr = crop && !crop.isNull() ? crop : obj.getInheritable("MediaBox");
  if (!arr || arr.isNull() || !arr.isArray()) {
    throw new ClipError("page has no MediaBox");
  }
  const nums: number[] = [];
  for (let i = 0; i < 4; i++) {
    const n = arr.get(i);
    if (!n || n.isNull()) throw new ClipError("page box is not a 4-number array");
    const v = n.asNumber();
    if (!Number.isFinite(v)) throw new ClipError("page box has a non-numeric entry");
    nums.push(v);
  }
  const [x0, y0, x1, y1] = nums as [number, number, number, number];
  if (!(x0 < x1 && y0 < y1)) throw new ClipError("page box is not non-empty and ordered");
  return [x0, y0, x1, y1];
}

function canonicalMarks(page: PDFPage, rects: readonly TransformRect[]): ClipRect[] {
  const obj = page.getObject();
  const box = rawPageBox(obj);
  const rotObj = obj.getInheritable("Rotate");
  const uuObj = obj.getInheritable("UserUnit");
  const ctx = makePageContext(
    box,
    rotObj && !rotObj.isNull() ? rotObj.asNumber() : 0,
    uuObj && !uuObj.isNull() ? uuObj.asNumber() : 1,
  );
  return rects.map((r) => {
    const c = viewportToPdf(
      r.page as PageIndex,
      { x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 },
      1,
      ctx,
    );
    return { x0: c.rect.x0, y0: c.rect.y0, x1: c.rect.x1, y1: c.rect.y1 };
  });
}

/** Raw (possibly indirect) XObject reference by name, or null when absent. */
function rawXObject(resources: PDFObject | null, name: string): PDFObject | null {
  if (!resources || resources.isNull()) return null;
  const xobjects = resources.get("XObject");
  if (!xobjects || xobjects.isNull()) return null;
  const obj = xobjects.get(name);
  if (!obj || obj.isNull()) return null;
  return obj;
}

function clipStreamObject(
  ref: PDFObject,
  ctm: ClipCtm,
  resources: PDFObject | null,
  marks: readonly ClipRect[],
  visit: ClipVisit,
  depth: number,
): void {
  if (depth > MAX_FORM_DEPTH) throw new ClipError("form nesting too deep");
  if (!ref.isIndirect()) throw new ClipError("content stream is not an indirect object");
  const num = ref.asIndirect();
  // A form that (transitively) contains itself cannot be clipped exactly.
  if (visit.active.has(num)) throw new ClipError("recursive form XObject");
  const doneKey = `${num}@${ctmKey(ctm)}`;
  if (visit.done.has(doneKey)) return; // idempotent: same stream, same CTM
  visit.active.add(num);
  try {
    let raw: Uint8Array;
    try {
      // asUint8Array may view WASM memory: copy before parsing.
      raw = new Uint8Array(ref.readStream().asUint8Array());
    } catch {
      throw new ClipError("unreadable content stream");
    }

    const host: ClipHost = {
      formMatrix(name: string): ClipCtm | null {
        const xref = rawXObject(resources, name);
        if (!xref) return null;
        const dict = xref.isIndirect() ? xref.resolve() : xref;
        if (dict.isNull()) return null;
        const subtype = dict.get("Subtype");
        if (subtype.isNull() || !subtype.isName() || subtype.asName() !== "Form") {
          return null;
        }
        const m = dict.get("Matrix");
        if (m.isNull()) return { ...IDENTITY_CTM };
        if (!m.isArray() || m.length !== 6) throw new ClipError("malformed form matrix");
        const v: number[] = [];
        for (let i = 0; i < 6; i++) {
          const el = m.get(i);
          if (!el || !el.isNumber()) throw new ClipError("malformed form matrix");
          const x = el.asNumber();
          if (!Number.isFinite(x)) throw new ClipError("malformed form matrix");
          v.push(x);
        }
        return { a: v[0]!, b: v[1]!, c: v[2]!, d: v[3]!, e: v[4]!, f: v[5]! };
      },
      clipForm(name: string, childCtm: ClipCtm): void {
        const xref = rawXObject(resources, name);
        if (!xref) throw new ClipError("form XObject vanished");
        const dict = xref.isIndirect() ? xref.resolve() : xref;
        const fr = dict.get("Resources");
        const scope = fr && !fr.isNull() ? fr : resources;
        clipStreamObject(xref, childCtm, scope, marks, visit, depth + 1);
      },
    };

    let out: Uint8Array | null;
    try {
      out = clipLineArtInStream(raw, { marks, ctm, host });
    } catch (e) {
      if (e instanceof ClipError) throw e;
      throw new ClipError("unexpected vector-clip failure");
    }
    if (out !== null) {
      try {
        ref.writeStream(out);
      } catch {
        throw new ClipError("content stream rewrite failed");
      }
    }
    visit.done.add(doneKey);
  } finally {
    visit.active.delete(num);
  }
}

/**
 * Destructively clip every content stream of the page (including nested
 * Form XObjects) against the mark rectangles. Streams needing no change
 * are left byte-identical. Throws ClipError on anything unclippable.
 */
function clipPageLineArt(page: PDFPage, rects: readonly TransformRect[]): void {
  const marks = canonicalMarks(page, rects);
  const visit: ClipVisit = { done: new Set(), active: new Set() };
  const pageObj = page.getObject();
  const resObj = pageObj.getInheritable("Resources");
  const resources = resObj && !resObj.isNull() ? resObj : null;
  const contents = pageObj.get("Contents");
  if (contents.isNull()) throw new ClipError("page has no content stream");
  if (contents.isArray()) {
    for (let i = 0; i < contents.length; i++) {
      const ref = contents.get(i);
      if (!ref || ref.isNull()) throw new ClipError("null content stream entry");
      clipStreamObject(ref, IDENTITY_CTM, resources, marks, visit, 0);
    }
  } else {
    clipStreamObject(contents, IDENTITY_CTM, resources, marks, visit, 0);
  }
}

/** Production backend: open, apply policy, full-rewrite save, self-check. */
export function createMuPdfBackend(): TransformBackend {
  return {
    async apply(payload: ArrayBuffer, rects: readonly TransformRect[]) {
      let doc: PDFDocument | null = null;
      try {
        doc = openPdfDocument(payload);
        const expectedPages = doc.countPages();
        applyRedactionPolicy(doc, rects);
        const saved = saveCandidate(doc);
        const selfCheck = runSelfCheck(saved, expectedPages);
        return { bytes: saved, selfCheck };
      } finally {
        doc?.destroy();
      }
    },
  };
}
