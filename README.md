# SafePDFly Engine

The open-source core of SafePDFly: browser-side PDF document processing —
input and page descriptors, MuPDF-based classification, redaction,
sanitization, and independent post-export verification. No network, no
persistence, no document bytes leaving the worker they were opened in.

## License

**AGPL-3.0-or-later** — see `LICENSE` (the verbatim GNU Affero General
Public License v3 text, as shipped with the MuPDF package).

This engine incorporates:

- **MuPDF** © Artifex Software, Inc. — `mupdf@1.28.1`, AGPL-3.0-or-later.
  Used for document classification, redaction, and sanitization.
- **pdfjs-dist** © Mozilla and contributors — `pdfjs-dist@6.3.289`,
  Apache-2.0. Used for page rasterization, text extraction, and the
  verification pass.

Both dependencies are pinned exactly (`peerDependencies` in
`package.json`): `mupdf` `1.28.1`, `pdfjs-dist` `6.3.289`.

## What copiers receive

Everything under this directory: the worker protocols, the engine
implementations, the page-geometry core, the support/unsupported-feature
policy, and the no-network guard. The worker-protocol boundary is the
contract: each subdomain exposes a versioned message protocol plus a
host-side client (`client.js`) and wire types (`protocol.js`). Nothing
outside those surfaces is part of the public contract.

## What is NOT here

The proprietary experience layer stays private and is not part of this
package: the PII finder, the lie detector, the UI, the orchestration,
and the licensing code. They consume the engine only through the blessed
client/protocol surfaces — never engine internals.

## Publication status

This is the published engine source, released under AGPL-3.0-or-later —
the license required for network-distributed use of the AGPL-licensed
MuPDF core it builds on.
