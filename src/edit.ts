import { UserError, asObject, optBool, reqString } from "./validate.ts";

export interface Edit {
  old_str: string;
  new_str: string;
  replace_all: boolean;
}

export const MAX_EDITS = 50;

/** Validate the `edits` argument of a patched file. */
export function parseEdits(v: unknown, label: string, maxNew: number): Edit[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_EDITS) {
    throw new UserError(`${label}: edits must be an array of 1-${MAX_EDITS} {old_str, new_str} objects`);
  }
  return v.map((raw, i) => {
    const o = asObject(raw, `${label}[${i}]`);
    return {
      old_str: reqString(o.old_str, `${label}[${i}].old_str`, 1, maxNew),
      new_str: reqString(o.new_str, `${label}[${i}].new_str`, 0, maxNew),
      replace_all: optBool(o.replace_all, `${label}[${i}].replace_all`, false),
    };
  });
}

/**
 * Apply str_replace-style edits in order, all-or-none. Each old_str must match
 * exactly once unless replace_all is set. Uses split/join so `$` in new_str is literal.
 */
export function applyEdits(text: string, edits: Edit[], path: string): { text: string; replacements: number } {
  let out = text;
  let replacements = 0;
  edits.forEach((e, i) => {
    const where = `${path} edit ${i + 1}`;
    const parts = out.split(e.old_str);
    const count = parts.length - 1;
    if (count === 0) {
      throw new UserError(
        `${where}: old_str not found. Copy it exactly (whitespace, line endings); edits apply in order, so earlier edits may have changed the text. Nothing was committed.`,
      );
    }
    if (count > 1 && !e.replace_all) {
      throw new UserError(
        `${where}: old_str matches ${count} places. Add surrounding lines to make it unique, or set replace_all: true. Nothing was committed.`,
      );
    }
    out = parts.join(e.new_str);
    replacements += count;
  });
  if (out === text) throw new UserError(`${path}: edits produce no change. Nothing was committed.`);
  return { text: out, replacements };
}

export function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * Render a file for the model: a one-line header (path, branch, short blob sha
 * for expected_sha, line count) followed by the requested line range. Output is
 * capped at maxChars on a line boundary and says where to continue.
 */
export function renderFile(
  info: { path: string; branch: string; sha: string },
  text: string,
  o: { start: number; end: number; numbered: boolean },
  maxChars = 60_000,
): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const from = o.start > 0 ? o.start : 1;
  if (total > 0 && from > total) throw new UserError(`start_line ${from} is past the end (file has ${total} lines)`);
  const to = Math.min(o.end > 0 ? o.end : total, total);

  const out: string[] = [];
  let size = 0;
  let n = from;
  for (; n <= to; n++) {
    let line = (o.numbered ? `${n}\t` : "") + lines[n - 1];
    if (out.length === 0 && line.length > maxChars) line = line.slice(0, maxChars) + " …[line truncated]";
    if (out.length > 0 && size + line.length + 1 > maxChars) break;
    out.push(line);
    size += line.length + 1;
  }
  const last = n - 1;
  const partial = from > 1 || last < total;
  const head =
    `# ${info.path} @ ${info.branch} · blob ${info.sha.slice(0, 7)} · ${total} lines` +
    (partial && total > 0 ? ` · showing ${from}-${last}` : "");
  const tail = n <= to ? `\n\n[output capped; continue with start_line=${n}]` : "";
  return `${head}\n\n${out.join("\n")}${tail}`;
}
