/** Errors safe to show to the model/user. Anything else is logged and hidden. */
export class UserError extends Error {}

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function validateBranchName(name: unknown, label = "branch"): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 200) {
    throw new UserError(`${label}: must be a non-empty string up to 200 chars`);
  }
  const segments = name.split("/");
  for (const seg of segments) {
    if (
      !SEGMENT_RE.test(seg) ||
      seg.startsWith(".") ||
      seg.endsWith(".") ||
      seg.endsWith(".lock") ||
      seg.includes("..")
    ) {
      throw new UserError(`${label}: invalid branch name`);
    }
  }
  return name;
}

/** A branch this server is allowed to create / push to. */
export function validateWritableBranch(
  name: unknown,
  prefix: string,
  defaultBranch: string,
  label = "branch",
): string {
  const b = validateBranchName(name, label);
  if (!b.startsWith(prefix) || b.length === prefix.length) {
    throw new UserError(`${label}: must start with "${prefix}" (writes are restricted to that prefix)`);
  }
  if (b === defaultBranch) throw new UserError(`${label}: the default branch is never writable`);
  return b;
}

/** owner/name. Rejects "." / ".." so a repo name can never rewrite the API URL path. */
export function validateRepoName(v: unknown, label = "repo"): string {
  if (typeof v !== "string" || v.length > 140 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) {
    throw new UserError(`${label}: must look like owner/name`);
  }
  for (const part of v.split("/")) {
    if (part === "." || part === "..") throw new UserError(`${label}: invalid repository name`);
  }
  return v;
}

// --- file path policy -------------------------------------------------------

/** Top-level directories that can execute code or change repo governance. */
const BLOCKED_TOP_DIRS = new Set([
  ".git",
  ".github",
  ".circleci",
  ".buildkite",
  ".azure-pipelines",
  ".gitlab",
]);

/** File names blocked at any depth (CI configs, review rules, git config). */
const BLOCKED_BASENAMES = new Set([
  "codeowners",
  ".gitmodules",
  ".gitattributes",
  ".gitlab-ci.yml",
  ".travis.yml",
  "jenkinsfile",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "cloudbuild.yaml",
  "cloudbuild.yml",
]);

function normSegment(seg: string): string {
  // Defeat trailing dot/space tricks on case/dot-insensitive filesystems.
  return seg.toLowerCase().replace(/[. ]+$/, "");
}

export function validateFilePath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 400) {
    throw new UserError("path: must be a non-empty string up to 400 chars");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new UserError(`path: illegal characters`);
  if (path.startsWith("/") || path.endsWith("/")) throw new UserError(`path: must be relative, no trailing slash`);
  const segments = path.split("/");
  segments.forEach((seg, i) => {
    const n = normSegment(seg);
    if (seg === "" || seg === "." || seg === ".." || n === "" || n === ".") {
      throw new UserError(`path: invalid segment in "${path}"`);
    }
    if (n === ".git" || /^git~\d+$/.test(n)) throw new UserError(`path: ".git" is not allowed`);
    if (i === 0 && BLOCKED_TOP_DIRS.has(n)) {
      throw new UserError(`path: "${segments[0]}/" is protected and cannot be modified through this server`);
    }
    if (i === segments.length - 1 && BLOCKED_BASENAMES.has(n)) {
      throw new UserError(`path: "${seg}" is protected and cannot be modified through this server`);
    }
  });
  return path;
}

// --- argument helpers -------------------------------------------------------

export function reqString(v: unknown, label: string, min = 1, max = 10_000): string {
  if (typeof v !== "string" || v.length < min || v.length > max) {
    throw new UserError(`${label}: must be a string of ${min}-${max} chars`);
  }
  return v;
}

export function optString(v: unknown, label: string, max = 10_000): string | undefined {
  if (v === undefined || v === null) return undefined;
  return reqString(v, label, 0, max);
}

/**
 * Some MCP clients send objects/arrays as JSON-encoded strings (e.g. pr: "{\"title\":\"x\"}").
 * Decode those instead of failing; anything else is returned unchanged.
 */
export function coerceJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

/**
 * Optional integer. Numeric strings ("3") are accepted. With clamp=true an out-of-range number is
 * pulled into [min, max] instead of rejected (use for soft limits like context lines or result caps).
 */
export function optInt(v: unknown, label: string, min: number, max: number, dflt: number, clamp = false): number {
  if (v === undefined || v === null || v === "") return dflt;
  let n: unknown = typeof v === "string" && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v;
  if (clamp && typeof n === "number" && Number.isFinite(n)) n = Math.min(max, Math.max(min, Math.round(n)));
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new UserError(`${label}: must be an integer ${min}-${max}`);
  }
  return n;
}

/** Optional boolean. The strings "true"/"false" are accepted. */
export function optBool(v: unknown, label: string, dflt: boolean): boolean {
  if (v === undefined || v === null || v === "") return dflt;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  if (typeof v !== "boolean") throw new UserError(`${label}: must be a boolean (true or false)`);
  return v;
}

export function asObject(v: unknown, label: string): Record<string, unknown> {
  const o = coerceJson(v);
  if (typeof o !== "object" || o === null || Array.isArray(o)) {
    throw new UserError(`${label}: must be an object${typeof v === "string" ? " (got a plain string; pass a JSON object such as {\"title\": \"...\"})" : ""}`);
  }
  return o as Record<string, unknown>;
}

export function asArray(v: unknown, label: string): unknown[] {
  const a = coerceJson(v);
  if (!Array.isArray(a)) throw new UserError(`${label}: must be an array`);
  return a;
}

export function truncate(text: string, max = 60_000): string {
  return text.length <= max ? text : text.slice(0, max) + `\n\n[truncated: ${text.length - max} more chars]`;
}

// --- content checks ---------------------------------------------------------

export interface ContentIssue {
  level: "error" | "warn";
  msg: string;
}

/** JSON files that commonly allow comments (JSONC): a parse failure is only a warning. */
const JSONC_FILE = /(?:^|\/)(?:[tj]sconfig[^/]*\.json|\.eslintrc\.json|\.vscode\/[^/]+\.json)$/i;

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cheap, dependency-free sanity checks run on every file a commit would write, so the
 * caller does not need a read-back round trip. Add checks here (keep them false-positive free).
 * `original` is the previous content when known: a file that was already broken only warns.
 */
export function checkContent(path: string, content: string, original?: string): ContentIssue[] {
  const out: ContentIssue[] = [];
  if (content.includes("\u0000")) out.push({ level: "error", msg: "contains a NUL byte" });
  if (/\.json$/i.test(path) && !parsesAsJson(content)) {
    let detail = "invalid JSON";
    try {
      JSON.parse(content);
    } catch (e) {
      detail = `invalid JSON (${(e as Error).message.slice(0, 160)})`;
    }
    const lenient = JSONC_FILE.test(path) || (original !== undefined && !parsesAsJson(original));
    out.push({ level: lenient ? "warn" : "error", msg: detail });
  }
  if (/^<{7} /m.test(content) && /^>{7} /m.test(content)) out.push({ level: "warn", msg: "contains merge conflict markers" });
  return out;
}
