/** Glob -> RegExp. Supports **, *, ?, {a,b}. A glob without "/" matches the file name at any depth. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let inBrace = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      inBrace = true;
      re += "(?:";
    } else if (c === "}" && inBrace) {
      inBrace = false;
      re += ")";
    } else if (c === "," && inBrace) re += "|";
    else re += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
  }
  if (inBrace) re += ")";
  return new RegExp(`^${glob.includes("/") ? "" : "(?:.*/)?"}${re}$`);
}

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MAX_LINE = 300;
const clip = (l: string) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + "…" : l);

/**
 * grep-style output for one file: `path:LINE:text` for matches, `path-LINE-text` for context,
 * `--` between non-adjacent groups. Stops after `budget` matches.
 */
export function grepText(
  path: string,
  text: string,
  re: RegExp,
  context: number,
  budget: number,
): { out: string[]; matches: number } {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const hits: number[] = [];
  for (let i = 0; i < lines.length && hits.length < budget; i++) {
    const l = lines[i]!.replace(/\r$/, "");
    if (re.test(l.length > 2000 ? l.slice(0, 2000) : l)) hits.push(i);
  }
  if (hits.length === 0) return { out: [], matches: 0 };

  const show = new Map<number, boolean>();
  for (const h of hits) {
    for (let j = Math.max(0, h - context); j <= Math.min(lines.length - 1, h + context); j++) {
      if (!show.has(j)) show.set(j, false);
    }
    show.set(h, true);
  }
  const out: string[] = [];
  let prev = -2;
  for (const j of [...show.keys()].sort((a, b) => a - b)) {
    if (context > 0 && prev >= 0 && j > prev + 1) out.push("--");
    const sep = show.get(j) ? ":" : "-";
    out.push(`${path}${sep}${j + 1}${sep}${clip(lines[j]!.replace(/\r$/, ""))}`);
    prev = j;
  }
  return { out, matches: hits.length };
}
