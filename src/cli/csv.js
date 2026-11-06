// CSV writing with quoting and protection against spreadsheet formula injection.

/** One cell: prefix risky starts with an apostrophe, then quote when needed. */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

export const csvLine = (cells) => cells.map(csvCell).join(',');
