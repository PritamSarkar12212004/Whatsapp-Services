/**
 * Minimal CSV utilities (no external dependency).
 *
 * - parseCsv(text) -> { headers, rows[] }
 * - toCsv(headers, rows[]) -> string
 *
 * Supports quoted fields containing commas, newlines and double-quotes
 * (RFC 4180 style) which are common in contact spreadsheets.
 */

/**
 * Parse a single CSV cell sequence honouring RFC 4180 quoting rules.
 * Returns the list of field values for the given line.
 */
const parseCsvLine = (line) => {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
};

/**
 * Parse CSV text into { headers: string[], rows: string[][] }.
 * Ignores trailing empty lines.
 */
export const parseCsv = (text) => {
  if (!text || typeof text !== "string") {
    return { headers: [], rows: [] };
  }

  // Normalise line endings
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const allLines = normalised.split("\n");
  // Drop trailing empty lines
  const lines = [];
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].trim() === "" && i === allLines.length - 1) continue;
    lines.push(allLines[i]);
  }

  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const fields = parseCsvLine(line);
    // Pad missing trailing fields with empty strings so field index lookups are safe
    while (fields.length < headers.length) fields.push("");
    rows.push(fields);
  }

  return { headers, rows };
};

/** Convert a rows[][] matrix plus headers into a CSV string. */
export const toCsv = (headers, rows) => {
  const escapeField = (value) => {
    const str = String(value ?? "");
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [headers.map(escapeField).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeField).join(","));
  }
  return lines.join("\n");
};

/**
 * Convert parsed CSV rows into objects keyed by header name.
 * Each row becomes { [header]: value }.
 */
export const csvRowsToObject = (headers, rows) =>
  rows.map((row) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = row[idx] !== undefined ? row[idx].trim() : "";
    });
    return obj;
  });
