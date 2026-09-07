/**
 * Builds an RFC 5987 / RFC 6266 compliant `Content-Disposition` header value for a file
 * download response.
 *
 * SECURITY/CORRECTNESS FIX (audit #16 - minor): `files.controller.ts` and
 * `backup.controller.ts` previously used `filename="${encodeURIComponent(name)}"` alone. That
 * works in the large majority of modern browsers as a practical matter, but it isn't the
 * standard-conformant way to convey a non-ASCII filename - `encodeURIComponent` output is not
 * valid inside a plain quoted `filename` parameter per RFC 6266, and older/stricter HTTP
 * clients may mishandle it (garbled name, or falling back to a generic name).
 *
 * The correct form supplies BOTH parameters:
 *   - `filename="..."` - a plain ASCII fallback for clients that don't understand `filename*`.
 *   - `filename*=UTF-8''...` - the RFC 5987 extended-value form, percent-encoded per its own
 *     stricter attr-char rule (a superset of what `encodeURIComponent` alone escapes: it also
 *     escapes `!  *  '  (  )`, which `encodeURIComponent` leaves untouched but RFC 5987 does not
 *     permit unescaped in this position).
 *
 * @param originalName - The human-readable filename to present to the client (may contain
 *   non-ASCII characters, spaces, etc.).
 * @returns A complete `Content-Disposition` header value, e.g.
 *   `attachment; filename="rapport.pdf"; filename*=UTF-8''rapport.pdf`.
 */
export function buildContentDisposition(originalName: string): string {
    // ASCII-only fallback: strip anything outside the printable ASCII range and drop characters
    // that would otherwise need escaping inside a quoted-string, so this half never needs its
    // own percent-encoding.
    const asciiFallback = originalName
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/["\\]/g, '_') || 'download';

    // RFC 5987 `attr-char` = ALPHA / DIGIT / "!" / "#" / "$" / "&" / "+" / "-" / "." / "^" / "_"
    // / "`" / "|" / "~". Everything else - including characters `encodeURIComponent` leaves
    // unescaped like `! * ' ( )` - must be percent-encoded.
    const extendedValue = encodeURIComponent(originalName).replace(
        /[!*'()]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );

    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${extendedValue}`;
}
