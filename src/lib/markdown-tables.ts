/**
 * Repairs near-miss GFM tables in model output before react-markdown parses it.
 *
 * GFM has no partial credit for a table: if the delimiter row's cell count does
 * not match the header's, or the rows arrive without the newlines that separate
 * them, or the header is glued to the paragraph above it, the parser silently
 * falls back to a paragraph. A paragraph collapses every newline into a space,
 * so a nine-column research table renders as one unreadable run of pipes rather
 * than as a table — the failure a reader actually sees.
 *
 * Models emit all three of these often enough that repairing them beats losing
 * the table. Each repair is deliberately narrow: it only rewrites text that is
 * already unambiguously a broken table, so prose that merely contains pipes or
 * dashes is left exactly as written.
 */

/** A delimiter cell: optional alignment colons around a run of dashes. */
const DELIMITER_CELL = /^:?-+:?$/;

/** A run of delimiter cells embedded anywhere in a line, e.g. `|---|:--:|`. */
const DELIMITER_RUN = /\|(?:\s*:?-+:?\s*\|)+/;

/** Splits a table row into cells, dropping the empty edges around outer pipes. */
function cells(row: string): string[] {
  const parts = row.trim().split("|");
  if (parts[0]?.trim() === "") parts.shift();
  if (parts.at(-1)?.trim() === "") parts.pop();
  return parts.map((cell) => cell.trim());
}

/** Renders cells back as a pipe-delimited row. */
const row = (values: string[]): string => `| ${values.join(" | ")} |`;

/** True when every cell of a non-empty line is a delimiter cell. */
function isDelimiterRow(line: string): boolean {
  const parts = cells(line);
  return parts.length > 0 && parts.every((cell) => DELIMITER_CELL.test(cell));
}

/** True when a line carries enough pipes to be a table row rather than prose. */
const looksLikeRow = (line: string): boolean => cells(line).length >= 2 && line.includes("|");

/**
 * Rebuilds a delimiter row to `count` cells, keeping the alignment the model
 * asked for where it supplied one and padding the rest with plain dashes.
 */
function fitDelimiter(line: string, count: number): string {
  const supplied = cells(line);
  return row(Array.from({ length: count }, (_, i) => supplied[i] ?? "---"));
}

/**
 * Explodes a table that arrived on a single line into header, delimiter and
 * body rows. The header is whatever precedes the delimiter run; the body is
 * chunked into rows of the header's width, since that is the only cell count
 * the table can actually have.
 */
function splitInlineTable(line: string): string[] | null {
  const match = DELIMITER_RUN.exec(line);
  if (!match) return null;
  const header = line.slice(0, match.index);
  const body = line.slice(match.index + match[0].length);
  const headers = cells(header);
  // Two columns is the smallest table worth rescuing; below that the pipes are
  // far more likely to be prose (a "yes | no" aside) than a mangled table.
  if (headers.length < 2) return null;
  // The delimiter run has to end the line or be followed by more table, never
  // by a sentence that happens to sit after a row of dashes.
  if (body.trim() !== "" && !body.includes("|")) return null;

  const lines = [row(headers), row(Array.from({ length: headers.length }, () => "---"))];
  let chunk: string[] = [];
  for (const value of cells(body)) {
    // The `| |` that joins two rows on one line reads as an empty cell. Only
    // the one sitting exactly on a row boundary is that artifact; an empty
    // cell the model actually wrote survives, because the boundary consumed
    // its own separator first.
    if (chunk.length === 0 && value === "") continue;
    chunk.push(value);
    if (chunk.length === headers.length) {
      lines.push(row(chunk));
      chunk = [];
    }
  }
  // A trailing short row is padded so the table keeps its rectangle — the
  // common case is a message still streaming its last row in.
  if (chunk.length > 0) {
    while (chunk.length < headers.length) chunk.push("");
    lines.push(row(chunk));
  }
  return lines;
}

/**
 * Applies the three repairs outside fenced code, where a table is prose and a
 * pipe is just a pipe. Text with no broken table is returned unchanged.
 */
export function repairMarkdownTables(text: string): string {
  if (!text.includes("|")) return text;

  const source = text.split("\n");
  const out: string[] = [];
  let fence: string | null = null;

  for (const line of source) {
    const fenceMark = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (fenceMark && line.trim().startsWith(fence)) fence = null;
      out.push(line);
      continue;
    }
    if (fenceMark) {
      fence = fenceMark[1].slice(0, 3);
      out.push(line);
      continue;
    }

    // A whole table mashed onto one line: split it before anything else, so the
    // delimiter and blank-line repairs below see ordinary rows.
    const inlineMatch = DELIMITER_RUN.exec(line);
    if (inlineMatch && !isDelimiterRow(line)) {
      const split = splitInlineTable(line);
      if (split) {
        // The header may need separating from the paragraph above it too.
        if (out.length > 0 && out.at(-1)?.trim() !== "" && !looksLikeRow(out.at(-1) ?? "")) out.push("");
        out.push(...split);
        continue;
      }
    }

    if (isDelimiterRow(line)) {
      const header = out.at(-1) ?? "";
      if (looksLikeRow(header)) {
        // A table cannot interrupt a paragraph — without a blank line above it
        // the header is only a lazy continuation and the table never parses.
        // This applies whatever else the delimiter needs, so it comes first.
        const before = out.at(-2);
        if (before !== undefined && before.trim() !== "" && !looksLikeRow(before)) {
          out.splice(out.length - 1, 0, "");
        }
        // GFM demands an exact match; one cell out and the table is a paragraph.
        const width = cells(header).length;
        if (cells(line).length !== width) {
          out.push(fitDelimiter(line, width));
          continue;
        }
      }
    }

    out.push(line);
  }

  return out.join("\n");
}
