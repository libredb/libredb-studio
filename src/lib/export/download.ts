/**
 * The one "save this to the user's disk" path in the studio.
 *
 * Seven exports had grown their own copy of the same six lines, and every copy
 * carried the same two problems:
 *
 * 1. The anchor was never put in the document. A detached `<a download>` is honoured
 *    by Chromium but ignored by Firefox, so those exports simply did nothing there.
 * 2. `URL.revokeObjectURL` was called on the line after `click()`. The click only
 *    STARTS the download; revoking the URL in the same task can pull the blob out
 *    from under a read that has not begun yet, which is why the failure shows up on
 *    large results and never on the small one a developer tries.
 *
 * Both are fixed once, here.
 */

/** How long the object URL is kept alive after the click that consumes it. */
const REVOKE_DELAY_MS = 0;

/** Hand `blob` to the browser as a download named `fileName`. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  // The anchor has to be IN the document for Firefox to honour the click, and it
  // must not be visible while it is: one frame of a stray link at the end of the
  // body is enough to shift a layout.
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // A later task, so the download has been handed off before the blob is dropped.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/**
 * The UTF-8 byte order mark, and the one format that needs it.
 *
 * Excel decides a CSV's encoding from its first bytes; the charset on the download is
 * not consulted. Without the mark it reads the file in the host's legacy code page,
 * and every non-ASCII character in it arrives mangled — which is most exports outside
 * an English-language database. Every other reader treats the mark as insignificant.
 *
 * Only CSV: prepending it to JSON would break a strict parser, and to SQL would put
 * a stray character in front of the first statement.
 */
const BOM = "﻿";
const NEEDS_BOM = /^text\/csv\b/;

/** Hand `content` to the browser as a `mimeType` download named `fileName`. */
export function downloadText(content: string, mimeType: string, fileName: string): void {
  const bytes = NEEDS_BOM.test(mimeType) ? `${BOM}${content}` : content;
  downloadBlob(new Blob([bytes], { type: mimeType }), fileName);
}
