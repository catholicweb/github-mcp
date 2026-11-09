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

export function optInt(v: unknown, label: string, min: number, max: number, dflt: number): number {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new UserError(`${label}: must be an integer ${min}-${max}`);
  }
  return v;
}

export function optBool(v: unknown, label: string, dflt: boolean): boolean {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "boolean") throw new UserError(`${label}: must be a boolean`);
  return v;
}

export function asObject(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new UserError(`${label}: must be an object`);
  return v as Record<string, unknown>;
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
