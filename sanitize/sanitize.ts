/**
 * T099 — metadata & hidden-layer sanitization (Pro, opt-in).
 *
 * Runs inside the redaction worker, after the redaction policy and before
 * the full-rewrite save: the sanitized candidate then travels the normal
 * independent verification path. Removes privacy-leaking non-content data:
 *
 *  1. the document Info dictionary (author/title/subject/keywords/creator/
 *     producer/dates) — dropped from the trailer;
 *  2. the XMP metadata stream — dropped from the catalog;
 *  3. the EmbeddedFiles and JavaScript name trees — dropped from /Names
 *     (other name trees such as Dests are navigation aids, not hidden
 *     data, and are kept);
 *  4. document-level actions — /OpenAction and the catalog /AA dictionary.
 *
 * Out of scope by task text: page-level /AA entries, annotations (kept —
 * the user may need them), and the redaction itself. Page content, images,
 * and vector graphics are never touched.
 *
 * Fail closed: any metadata structure that is present but malformed (Info
 * that is not a dictionary, a /Metadata entry that is not a stream, a name
 * tree that is not a dictionary, a non-dictionary /AA) throws
 * SanitizeError. The worker boundary maps it to TRANSFORM_FAILED — no
 * candidate, no grant.
 *
 * Structural typing only: this module never imports "mupdf". The mutation
 * boundary stays in src/pdf/redact/adapter.ts, which passes the real
 * MuPDF document in (structurally compatible).
 */

/** Stable failure: a metadata structure was present but malformed. */
export class SanitizeError extends Error {
  constructor(reason: string) {
    super(`sanitize:${reason}`);
    this.name = "SanitizeError";
  }
}

/** Minimal structural surface of the MuPDF PDFObject API used here. */
export interface SanitizeObject {
  isNull(): boolean;
  isIndirect(): boolean;
  isDictionary(): boolean;
  isStream(): boolean;
  resolve(): SanitizeObject;
  get(key: string): SanitizeObject;
  delete(key: string): void;
}

/** Minimal structural surface of the MuPDF PDFDocument API used here. */
export interface SanitizeDocument {
  getTrailer(): SanitizeObject;
}

/**
 * Resolve one indirection level, then require a dictionary. The binding's
 * type predicates transparently resolve indirect references, so the raw
 * value is authoritative for the type check — but key deletion must run
 * against the resolved dictionary object itself.
 */
function asDict(obj: SanitizeObject, what: string): SanitizeObject {
  const target = obj.isIndirect() ? obj.resolve() : obj;
  if (!target.isDictionary()) {
    throw new SanitizeError(`${what}-not-a-dictionary`);
  }
  return target;
}

/** Drop one name tree from /Names. Absent is fine; malformed fails closed. */
function dropNameTree(namesDict: SanitizeObject, key: string): void {
  const tree = namesDict.get(key);
  if (tree.isNull()) return;
  asDict(tree, `names-${key}`);
  namesDict.delete(key);
}

/**
 * Strip the hidden layers listed above from an open document, in place.
 * Throws SanitizeError on any malformed metadata structure. Never touches
 * page content, annotations, or the applied redaction.
 */
export function sanitizeDocument(doc: SanitizeDocument): void {
  const trailer = doc.getTrailer();

  // 1. Document Info dictionary (author/title/etc.).
  const info = trailer.get("Info");
  if (!info.isNull()) {
    asDict(info, "info");
    trailer.delete("Info");
  }

  const rootValue = trailer.get("Root");
  if (rootValue.isNull()) {
    throw new SanitizeError("no-root");
  }
  const root = asDict(rootValue, "root");

  // 2. XMP metadata stream. The raw value's isStream predicate resolves
  // the indirection itself; resolving a stream object further is not
  // meaningful, so the raw value is checked and the catalog key deleted.
  const metadata = root.get("Metadata");
  if (!metadata.isNull()) {
    if (!metadata.isStream()) {
      throw new SanitizeError("metadata-not-a-stream");
    }
    root.delete("Metadata");
  }

  // 3. Embedded files and document-level JavaScript name trees.
  const names = root.get("Names");
  if (!names.isNull()) {
    const namesDict = asDict(names, "names");
    dropNameTree(namesDict, "EmbeddedFiles");
    dropNameTree(namesDict, "JavaScript");
  }

  // 4. Document-level actions: the open action and additional actions.
  if (!root.get("OpenAction").isNull()) {
    root.delete("OpenAction");
  }
  const aa = root.get("AA");
  if (!aa.isNull()) {
    asDict(aa, "aa");
    root.delete("AA");
  }
}
