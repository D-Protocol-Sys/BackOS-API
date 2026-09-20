/**
 * SECURITY HARDENING (independent audit finding): `multer.config.ts`'s `fileFilter` and
 * `FilesService.saveUploadedFile()` both validate uploads against `file.mimetype` - but that
 * value comes straight from the `Content-Type` header of the multipart field, which is entirely
 * client-controlled and trivially spoofed (e.g. `curl -F "file=@payload.html;type=image/png"`
 * uploads an HTML/script payload while claiming to be a PNG). The existing allowlist therefore
 * filters on a label the attacker writes, not on what the file actually contains.
 *
 * This is partially mitigated elsewhere (`FilesController.download()` always sends
 * `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`, so a mislabeled file
 * can't be rendered inline by a browser to trigger stored XSS), but it does nothing to stop:
 *   - malware/junk being stored and redistributed to other users under a trusted-looking label,
 *   - a corrupt/hostile file later reaching a library that DOES trust the declared type (an
 *     image resizer, an Office/PDF previewer, an antivirus-less download by an admin who opens
 *     it locally trusting the extension `FilesService` assigned it).
 *
 * `matchesFileSignature()` adds a second, content-based check: it reads the first bytes actually
 * written to disk and confirms they match the magic-byte signature expected for the MIME type
 * the uploader claimed. This is deliberately dependency-free (no `file-type` package pull-in,
 * which is ESM-only in current majors and would need extra bundler/tsconfig work) - it covers
 * exactly the fixed allowlist in `file-type.constant.ts`, nothing more, nothing less.
 *
 * Plain-text formats (`text/plain`, `text/csv`) have no magic-byte signature by definition, so
 * they get a heuristic instead: reject the file if the sampled header bytes contain a NUL byte,
 * which legitimate UTF-8/ASCII/Latin-1 text never does but arbitrary binaries typically do.
 */

/** Number of leading bytes read from disk before running a signature check. */
export const SIGNATURE_SAMPLE_BYTES = 32;

type SignatureMatcher = (buf: Buffer) => boolean;

const startsWith = (buf: Buffer, bytes: number[]): boolean =>
    bytes.length <= buf.length && bytes.every((b, i) => buf[i] === b);

/** RIFF....WEBP - the WEBP fourCC sits at offset 8, after the 4-byte RIFF size field. */
const isWebp = (buf: Buffer): boolean =>
    buf.length >= 12 &&
    startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && // "RIFF"
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50; // "WEBP"

/** Legacy OLE2/CFBF container - shared by pre-2007 .doc / .xls / .ppt. */
const isCfbf = (buf: Buffer): boolean =>
    startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Modern Office formats (.docx/.xlsx/.pptx) and plain .zip are all ZIP containers. */
const isZip = (buf: Buffer): boolean =>
    startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || // normal
    startsWith(buf, [0x50, 0x4b, 0x05, 0x06]) || // empty archive
    startsWith(buf, [0x50, 0x4b, 0x07, 0x08]);   // spanned archive

/** No NUL byte in the sampled header - simple but effective binary-vs-text heuristic. */
const looksLikeText = (buf: Buffer): boolean => !buf.subarray(0, SIGNATURE_SAMPLE_BYTES).includes(0x00);

const SIGNATURES: Record<string, SignatureMatcher> = {
    'application/pdf': (buf) => startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d]), // "%PDF-"
    'image/jpeg': (buf) => startsWith(buf, [0xff, 0xd8, 0xff]),
    'image/png': (buf) => startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'image/gif': (buf) => startsWith(buf, [0x47, 0x49, 0x46, 0x38]), // "GIF8" (87a or 89a)
    'image/webp': isWebp,
    'application/zip': isZip,
    'application/x-zip-compressed': isZip,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': isZip,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': isZip,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': isZip,
    'application/msword': isCfbf,
    'application/vnd.ms-excel': isCfbf,
    'application/vnd.ms-powerpoint': isCfbf,
    'text/plain': looksLikeText,
    'text/csv': looksLikeText,
};

/**
 * Verifies that the leading bytes of an uploaded file match the magic-byte signature expected
 * for `mimetype`. Returns `true` for any MIME type this module does not have a rule for, so
 * adding a new entry to `ALLOWED_FILE_TYPES` never silently starts failing uploads until a
 * matching signature is added here too - this is a hardening layer on top of the allowlist, not
 * a replacement for it.
 *
 * @param mimetype - The MIME type the uploader claims (already checked against the allowlist).
 * @param sample - The first `SIGNATURE_SAMPLE_BYTES` bytes actually read back from disk.
 */
export function matchesFileSignature(mimetype: string, sample: Buffer): boolean {
    const matcher = SIGNATURES[mimetype];
    if (!matcher) return true;
    return matcher(sample);
}
