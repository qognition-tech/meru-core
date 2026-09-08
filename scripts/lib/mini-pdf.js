/**
 * A minimal, dependency-free PDF writer — enough for demo documents, no more.
 *
 * Why not pdfkit: this runs immediately before a deploy, and `check:cjs` exists
 * precisely because one unexpected package in the graph has twice returned
 * FUNCTION_INVOCATION_FAILED on every request. A seed script is not worth
 * that risk, and the subset of PDF needed to render headed, monospaced-looking
 * text on A4 is about a hundred lines.
 *
 * Scope, stated so nobody mistakes this for a PDF library: single font
 * (Helvetica + Helvetica-Bold), no images, no embedded fonts, no compression,
 * WinAnsi text only. Anything beyond that belongs in a real library.
 */

const A4 = { width: 595.28, height: 841.89 };

/**
 * PDF string literals are delimited by unescaped parentheses, so a stray one in
 * a name or address would truncate the object and produce a file that opens to
 * a blank page. Backslash first, or it would escape the escapes.
 */
function escapeText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * WinAnsiEncoding covers Latin-1 and little else. Demo data contains em dashes
 * and curly quotes from ordinary prose, and those would render as garbage
 * glyphs rather than failing loudly — so they are folded to ASCII here instead
 * of being discovered by eye in front of a client.
 */
function toWinAnsi(s) {
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

/**
 * Build a one-page PDF.
 *
 * `lines` is an array of either a string (body text) or
 * `{ text, bold, size, gap }`. Layout is deliberately dumb: a fixed left
 * margin and a running y cursor. Lines that would run past the bottom margin
 * are dropped rather than silently overlapping the footer.
 */
function buildPdf({ title, lines, footer }) {
  const objects = [];
  const push = (body) => {
    objects.push(body);
    return objects.length; // 1-indexed object numbers
  };

  const margin = 56;
  let y = A4.height - margin;
  const ops = [];

  const write = (text, { bold = false, size = 10, gap = 4 } = {}) => {
    const lineHeight = size + gap;
    if (y - lineHeight < margin) return; // ran out of page; drop, don't overlap
    y -= lineHeight;
    ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${margin} ${y.toFixed(2)} Tm (${escapeText(
        toWinAnsi(text),
      )}) Tj ET`,
    );
  };

  if (title) {
    write(title, { bold: true, size: 16, gap: 10 });
    // A rule under the heading, so the page reads as a document rather than a
    // wall of text in a screenshot.
    y -= 6;
    ops.push(
      `0.6 w 0.35 0.35 0.35 RG ${margin} ${y.toFixed(2)} m ${(
        A4.width - margin
      ).toFixed(2)} ${y.toFixed(2)} l S`,
    );
    y -= 10;
  }

  for (const line of lines || []) {
    if (line === '') {
      y -= 8;
      continue;
    }
    if (typeof line === 'string') write(line);
    else write(line.text, line);
  }

  if (footer) {
    ops.push(
      `BT /F1 8 Tf 1 0 0 1 ${margin} ${margin - 18} Tm 0.45 0.45 0.45 rg (${escapeText(
        toWinAnsi(footer),
      )}) Tj ET`,
    );
  }

  const stream = ops.join('\n');

  const font1 = push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const font2 = push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );
  const content = push(
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  );
  // Page and Pages reference each other, so one number is reserved before the
  // object it names exists.
  const pagesNum = objects.length + 2;
  const page = push(
    `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
      `/Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${content} 0 R >>`,
  );
  const pages = push(`<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  const catalog = push(`<< /Type /Catalog /Pages ${pages} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

module.exports = { buildPdf };
