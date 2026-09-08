import { csvField, toCsv } from './csv';

/**
 * CSV that survives real data.
 *
 * The audit exporter did `row.join(',')`, which is wrong the first time a
 * description contains a comma: the row gains a column and every field after it
 * shifts. In a file someone reconciles against, a shifted column is worse than a
 * failed export, because nothing announces it.
 */
describe('csvField', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvField('Priya Sharma')).toBe('Priya Sharma');
  });

  it('quotes a value containing a comma', () => {
    expect(csvField('Sharma, Priya')).toBe('"Sharma, Priya"');
  });

  it('doubles embedded quotes', () => {
    expect(csvField('known as "Pri"')).toBe('"known as ""Pri"""');
  });

  it('quotes a value containing a newline', () => {
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
  });

  it('renders null and undefined as empty, not as the words', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('renders a Date as ISO 8601', () => {
    expect(csvField(new Date('2026-08-11T00:00:00Z'))).toBe(
      '2026-08-11T00:00:00.000Z',
    );
  });

  it('serialises an object rather than emitting [object Object]', () => {
    expect(csvField({ subclass: '482' })).toBe('"{""subclass"":""482""}"');
  });

  it('renders zero and false, which are values', () => {
    expect(csvField(0)).toBe('0');
    expect(csvField(false)).toBe('false');
  });

  describe('formula injection', () => {
    // A cell beginning =, +, - or @ executes when the file is opened.
    // `=HYPERLINK(...)` and `=WEBSERVICE(...)` exfiltrate the row to a URL the
    // attacker picks, and the attacker is anyone who can type a client's name.
    /** The cell's value, with any CSV quoting removed. */
    const cellValue = (field: string) =>
      field.startsWith('"')
        ? field.slice(1, -1).replace(/""/g, '"')
        : field;

    it.each(['=1+1', '+1', '-1', '@SUM(A1)', '=HYPERLINK("http://evil","x")'])(
      'defuses %s',
      (payload) => {
        // Asserted on the value rather than the raw field: a payload containing
        // a quote or comma is *also* CSV-quoted, so the apostrophe correctly
        // sits inside the quotes rather than before them.
        expect(cellValue(csvField(payload))).toMatch(/^'/);
      },
    );

    it('still lets a human read the value', () => {
      // Excel strips the leading apostrophe on display.
      expect(csvField('=1+1')).toBe("'=1+1");
    });

    it('does not touch a value that merely contains an equals sign', () => {
      expect(csvField('a=b')).toBe('a=b');
    });
  });
});

describe('toCsv', () => {
  it('writes a header row and CRLF line endings', () => {
    // RFC 4180, and what Excel on Windows expects — a lone \n renders as one
    // long line for a meaningful share of users.
    const csv = toCsv(['a', 'b'], [[1, 2]]);
    expect(csv).toBe('a,b\r\n1,2');
  });

  it('keeps columns aligned when a value contains the delimiter', () => {
    const csv = toCsv(
      ['name', 'note'],
      [['Sharma, Priya', 'ok']],
    );
    // Three commas would mean the parser sees three columns; two of them are
    // inside quotes, so it sees two.
    expect(csv.split('\r\n')[1]).toBe('"Sharma, Priya",ok');
  });

  it('emits only headers for an empty set', () => {
    expect(toCsv(['a'], [])).toBe('a');
  });
});
