/**
 * CSV writing that survives real data.
 *
 * `rows.map(r => r.join(','))` is the obvious version and is wrong the first time
 * a value contains a comma, a quote or a newline — the row silently gains a
 * column and every field after it shifts. A shifted column in an export a
 * compliance officer reconciles against is worse than a failed export, because
 * nothing announces it.
 */

/** Characters that make Excel and Sheets treat a cell as a formula. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * One CSV field, quoted and escaped per RFC 4180.
 *
 * Also defuses formula injection. A cell beginning `=`, `+`, `-` or `@` is
 * executed as a formula when the file is opened — `=HYPERLINK(...)` and
 * `=WEBSERVICE(...)` exfiltrate the row's contents to a URL the attacker
 * chooses, and the attacker here is anyone who can type a client's name into the
 * CRM. Prefixed with an apostrophe, which Excel strips on display, so the value
 * still reads correctly to a human.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

  if (text.length && FORMULA_PREFIXES.includes(text[0])) {
    text = `'${text}`;
  }

  // Quote whenever a delimiter, quote or newline is present, and double any
  // embedded quotes. Always quoting would also be correct but makes every export
  // harder for a human to read.
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * A full CSV document.
 *
 * CRLF line endings, because that is what RFC 4180 specifies and what Excel on
 * Windows expects; a lone `\n` renders as one long line for a meaningful share of
 * users.
 */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvField).join(','));
  }
  return lines.join('\r\n');
}
