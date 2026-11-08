import { BranchMissing, GitHub, GitHubError, bytesToUtf8, encPath, type TreeEntry } from "./github.ts";
import { applyEdits, countLines, parseEdits, renderFile, type Edit } from "./edit.ts";
import { escapeRegExp, globToRegExp, grepText } from "./search.ts";
import {
  UserError,
  asObject,
  checkContent,
  optBool,
  optInt,
  optString,
  reqString,
  truncate,
  validateBranchName,
  validateFilePath,
  validateWritableBranch,
} from "./validate.ts";

export interface Config {
  repo: string;
  defaultBranch: string;
  prefix: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint?: boolean; openWorldHint: false };
  run: (gh: GitHub, cfg: Config, args: Record<string, unknown>) => Promise<string>;
}

const MAX_FILES = 50;
const MAX_FILE_CHARS = 200_000;
const MAX_TOTAL_CHARS = 1_000_000;
const REGULAR_FILE = "100644";

const json = (v: unknown) => JSON.stringify(v); // compact: fewer tokens than pretty-printing

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const writeNonDestructive = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

interface PrInput {
  title: string;
  body: string;
  draft: boolean;
}

function parsePr(v: unknown, label: string): PrInput | undefined {
  if (v === undefined || v === null) return undefined;
  const o = asObject(v, label);
  return {
    title: reqString(o.title, `${label}.title`, 1, 256),
    body: optString(o.body, `${label}.body`, 20_000) ?? "",
    draft: optBool(o.draft, `${label}.draft`, false),
  };
}

/** Open a PR into the default branch, or return the one already open for this head (idempotent). */
async function openPr(gh: GitHub, cfg: Config, head: string, pr: PrInput): Promise<string> {
  try {
    const owner = cfg.repo.split("/")[0];
    const existing = await gh.request<{ number: number; html_url: string }[]>(
      "GET",
      `/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(cfg.defaultBranch)}`,
    );
    const first = Array.isArray(existing) ? existing[0] : undefined;
    if (first) return `PR #${first.number} already open: ${first.html_url}`;
  } catch {
    /* best effort: if the lookup fails, creating below still fails safely on a duplicate */
  }
  const created = await gh.request<{ number: number; html_url: string }>("POST", "/pulls", {
    title: pr.title,
    head,
    base: cfg.defaultBranch,
    body: pr.body,
    draft: pr.draft,
    maintainer_can_modify: false,
  });
  return `Opened PR #${created.number}: ${created.html_url}`;
}

const GREP_MAX_FILES = 120; // each scanned file costs one GitHub subrequest
const GREP_MAX_FILE_BYTES = 200_000;
const GREP_SKIP_EXT = /\.(?:png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|tar|7z|woff2?|ttf|otf|eot|mp[34]|mov|avi|wasm|bin|exe|dll|so|dylib|class|jar|psd|sqlite3?)$/i;
const GREP_SKIP_LOCK = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock|poetry\.lock|Gemfile\.lock)$/;

type ContentsMeta =
  | { type: string; sha: string; size: number; path: string; content?: string; encoding?: string }
  | { type: string; name: string; path: string; size: number }[];

export const tools: ToolDef[] = [
  {
    name: "repo_tree",
    description:
      "List files in the repository (recursive) for a branch. Optionally filter by a path prefix. Returns path and size.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch name. Defaults to the repo default branch." },
        path_prefix: { type: "string", description: "Only list paths starting with this prefix." },
      },
      additionalProperties: false,
    },
    annotations: readOnly,
    async run(gh, cfg, a) {
      const branch = validateBranchName(a.branch ?? cfg.defaultBranch);
      const prefix = optString(a.path_prefix, "path_prefix", 400) ?? "";
      const head = await gh.branchHead(branch);
      const { tree, truncated } = await gh.getTree(head.treeSha);
      const files = tree
        .filter((e) => e.type === "blob" && e.path.startsWith(prefix))
        .slice(0, 3000)
        .map((e) => `${e.path}\t${e.size ?? 0}`);
      return `${files.length} files${truncated ? " (GitHub truncated the tree; narrow with path_prefix)" : ""}\n${files.join("\n")}`;
    },
  },
  {
    name: "file_get",
    description:
      "Read text files from a branch (or list a directory). Output starts with a one-line header (path, short blob sha, line count). " +
      "For big files read just what you need with start_line/end_line (1-based, inclusive) instead of the whole file; " +
      "output is capped and tells you where to continue. Pass `paths` (max 20) to read several files in one call. " +
      "line_numbers is off by default so text can be copied straight into push_files edits.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "One file or directory. Use this or `paths`." },
        paths: { type: "array", items: { type: "string" }, description: "Several files in one call (max 20); the line range applies to each." },
        branch: { type: "string", description: "Defaults to the repo default branch." },
        start_line: { type: "integer", minimum: 1, description: "First line to return (default 1)." },
        end_line: { type: "integer", minimum: 1, description: "Last line to return (default: end of file)." },
        line_numbers: { type: "boolean", description: "Prefix each line with its number + tab (display only; never include it in edits). Default false." },
      },
      additionalProperties: false,
    },
    annotations: readOnly,
    async run(gh, cfg, a) {
      if (a.path !== undefined && a.paths !== undefined) throw new UserError("use either path or paths, not both");
      let paths: string[];
      if (a.paths !== undefined) {
        if (!Array.isArray(a.paths) || a.paths.length < 1 || a.paths.length > 20) throw new UserError("paths: must be an array of 1-20 paths");
        paths = a.paths.map((p, i) => reqString(p, `paths[${i}]`, 1, 400));
      } else {
        paths = [reqString(a.path, "path", 1, 400)];
      }
      for (const p of paths) if (p.includes("..") || p.startsWith("/")) throw new UserError("path: invalid");
      const branch = validateBranchName(a.branch ?? cfg.defaultBranch);
      const start = optInt(a.start_line, "start_line", 1, 10_000_000, 0);
      const end = optInt(a.end_line, "end_line", 1, 10_000_000, 0);
      if (start && end && end < start) throw new UserError("end_line must be >= start_line");
      const numbered = optBool(a.line_numbers, "line_numbers", false);

      const read = async (path: string, budget: number, multi: boolean): Promise<string> => {
        const meta = await gh.request<ContentsMeta>("GET", `/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`);
        if (Array.isArray(meta)) {
          const listing = meta.map((e) => `${e.type}\t${e.size}\t${e.path}`).join("\n");
          return multi ? `# ${path} (directory)\n\n${listing}` : listing;
        }
        if (meta.type !== "file") throw new UserError(`${path} is a ${meta.type}, not a regular file`);
        // The contents API already inlines files up to 1 MB; only fall back to the blob API when it does not.
        let b64 = meta.encoding === "base64" && meta.content ? meta.content : undefined;
        if (b64 === undefined) b64 = (await gh.request<{ content: string }>("GET", `/git/blobs/${meta.sha}`)).content;
        const text = bytesToUtf8(b64);
        if (text === null) return `${path} is a binary file (${meta.size} bytes); not shown.`;
        return renderFile({ path, branch, sha: meta.sha }, text, { start, end, numbered }, budget);
      };

      if (paths.length === 1) return read(paths[0]!, 60_000, false);
      // Multi-read: one bad path must not cost the caller a whole retry round.
      const budget = Math.floor(60_000 / paths.length);
      const blocks = await Promise.all(
        paths.map(async (p) => {
          try {
            return await read(p, budget, true);
          } catch (e) {
            if (e instanceof UserError) return `# ${p}: ERROR: ${e.message}`;
            throw e;
          }
        }),
      );
      return blocks.join("\n\n");
    },
  },
  {
    name: "grep",
    description:
      `Search file contents on a branch with a regex (or literal text). Returns "path:line:text" matches, with optional context lines, so you rarely need to read whole files. ` +
      `Scans at most ${GREP_MAX_FILES} text files (binary, >200 KB and lock files are skipped); narrow with path_prefix or glob.`,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regex, or plain text with literal=true." },
        branch: { type: "string", description: "Defaults to the repo default branch." },
        path_prefix: { type: "string", description: "Only search paths starting with this prefix." },
        glob: { type: "string", description: 'Only search matching paths, e.g. "**/*.ts" or "*.{js,ts}" (no "/" = match file name at any depth).' },
        literal: { type: "boolean", description: "Treat pattern as plain text." },
        ignore_case: { type: "boolean" },
        context: { type: "integer", minimum: 0, maximum: 5, description: "Lines of context around each match (default 0)." },
        max_results: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    annotations: readOnly,
    async run(gh, cfg, a) {
      const pattern = reqString(a.pattern, "pattern", 1, 300);
      const literal = optBool(a.literal, "literal", false);
      const ignoreCase = optBool(a.ignore_case, "ignore_case", false);
      let re: RegExp;
      try {
        re = new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? "i" : "");
      } catch (e) {
        throw new UserError(`pattern: invalid regex (${(e as Error).message.slice(0, 150)})`);
      }
      const prefix = optString(a.path_prefix, "path_prefix", 400) ?? "";
      const globStr = optString(a.glob, "glob", 200);
      let globRe: RegExp | null = null;
      try {
        globRe = globStr ? globToRegExp(globStr) : null;
      } catch {
        throw new UserError("glob: invalid pattern");
      }
      const context = optInt(a.context, "context", 0, 5, 0);
      const max = optInt(a.max_results, "max_results", 1, 200, 50);
      const branch = validateBranchName(a.branch ?? cfg.defaultBranch);

      const head = await gh.branchHead(branch);
      const { tree, truncated } = await gh.getTree(head.treeSha);
      let skipped = 0;
      const candidates = tree
        .filter((e) => e.type === "blob" && e.mode !== "120000" && e.path.startsWith(prefix) && (!globRe || globRe.test(e.path)))
        .filter((e) => {
          const skip = GREP_SKIP_EXT.test(e.path) || GREP_SKIP_LOCK.test(e.path) || (e.size ?? 0) > GREP_MAX_FILE_BYTES;
          if (skip) skipped++;
          return !skip;
        })
        .sort((x, y) => (x.path < y.path ? -1 : 1));
      const scanList = candidates.slice(0, GREP_MAX_FILES);

      const out: string[] = [];
      let matches = 0;
      let files = 0;
      let scanned = 0;
      for (let i = 0; i < scanList.length && matches < max; i += 10) {
        const batch = scanList.slice(i, i + 10);
        const texts = await Promise.all(
          batch.map(async (e) => bytesToUtf8((await gh.request<{ content: string }>("GET", `/git/blobs/${e.sha}`)).content)),
        );
        scanned += batch.length;
        for (let j = 0; j < batch.length && matches < max; j++) {
          const t = texts[j];
          if (t === null || t === undefined) continue;
          const r = grepText(batch[j]!.path, t, re, context, max - matches);
          if (r.matches === 0) continue;
          if (context > 0 && out.length > 0) out.push("--");
          out.push(...r.out);
          matches += r.matches;
          files++;
        }
      }

      const notes: string[] = [];
      if (matches >= max) notes.push("stopped at max_results");
      if (candidates.length > GREP_MAX_FILES) notes.push(`only the first ${GREP_MAX_FILES} of ${candidates.length} files were scanned; narrow with path_prefix or glob`);
      if (skipped > 0) notes.push(`${skipped} binary/large/lock files skipped`);
      if (truncated) notes.push("GitHub truncated the tree; narrow with path_prefix");
      const header = `${matches} match${matches === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"} (scanned ${scanned})${notes.length ? `; ${notes.join("; ")}` : ""}`;
      return truncate(out.length ? `${header}\n${out.join("\n")}` : header);
    },
  },
  {
    name: "branches_list",
    description: `List branches. By default only the writable "claude/" working branches are shown.`,
    inputSchema: {
      type: "object",
      properties: { all: { type: "boolean", description: "Show every branch, not just the working prefix." } },
      additionalProperties: false,
    },
    annotations: readOnly,
    async run(gh, cfg, a) {
      const all = optBool(a.all, "all", false);
      const list = await gh.request<{ name: string; protected: boolean }[]>("GET", `/branches?per_page=100`);
      return json(list.filter((b) => all || b.name.startsWith(cfg.prefix)).map((b) => ({ name: b.name, protected: b.protected })));
    },
  },
  {
    name: "branch_create",
    description: `Create a new working branch (must start with the allowed prefix, e.g. "claude/fix-typo") from the default branch or another branch.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: `New branch name, must start with the allowed prefix.` },
        from: { type: "string", description: "Branch to start from. Defaults to the repo default branch." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: writeNonDestructive,
    async run(gh, cfg, a) {
      const name = validateWritableBranch(a.name, cfg.prefix, cfg.defaultBranch, "name");
      const from = validateBranchName(a.from ?? cfg.defaultBranch, "from");
      const head = await gh.branchHead(from);
      await gh.request("POST", "/git/refs", { ref: `refs/heads/${name}`, sha: head.commitSha });
      return `Created branch ${name} from ${from} at ${head.commitSha.slice(0, 7)}.`;
    },
  },
  {
    name: "push_files",
    description:
      `Edit the repo: commit changes to a working branch (allowed prefix) in ONE commit, and optionally open the PR in the same call. ` +
      `Prefer "edits" (str_replace-style patch: old_str must match exactly once, or set replace_all) over resending a whole file; ` +
      `use "content" only for new files or full rewrites. "moves" renames without resending content. ` +
      `Set create_branch: true to create the branch from the default branch if it is missing, and pr to open (or reuse) the PR. ` +
      `Fast-forward only; never force; CI/workflow files (.github/, CODEOWNERS, etc.) are blocked; text files only.`,
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: `Working branch; must start with the allowed prefix, e.g. "claude/fix-typo".` },
        message: { type: "string", description: "Commit message." },
        create_branch: { type: "boolean", description: "Create the branch from the default branch if it does not exist (default false)." },
        files: {
          type: "array",
          description: "Files to change. Each needs path plus exactly one of content (full file) or edits (patch).",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string", description: "Full new content (create or overwrite)." },
              edits: {
                type: "array",
                description: "Patch an existing file. Applied in order, all-or-none.",
                items: {
                  type: "object",
                  properties: {
                    old_str: { type: "string", description: "Exact text to replace; must be unique in the file unless replace_all." },
                    new_str: { type: "string", description: "Replacement (empty string deletes)." },
                    replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
                  },
                  required: ["old_str", "new_str"],
                  additionalProperties: false,
                },
              },
              expected_sha: { type: "string", description: "Blob sha from the file_get header; fail instead of overwriting if the file changed since." },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
        moves: {
          type: "array",
          description: "Rename/move files without resending content.",
          items: {
            type: "object",
            properties: { from: { type: "string" }, to: { type: "string" } },
            required: ["from", "to"],
            additionalProperties: false,
          },
        },
        deletions: { type: "array", description: "Paths to delete.", items: { type: "string" } },
        pr: {
          type: "object",
          description: "Also open a PR into the default branch (reuses the PR if one is already open for this branch). Never merged by this server.",
          properties: { title: { type: "string" }, body: { type: "string" }, draft: { type: "boolean" } },
          required: ["title"],
          additionalProperties: false,
        },
      },
      required: ["branch", "message"],
      additionalProperties: false,
    },
    annotations: writeNonDestructive,
    async run(gh, cfg, a) {
      const branch = validateWritableBranch(a.branch, cfg.prefix, cfg.defaultBranch);
      const message = reqString(a.message, "message", 1, 2000);
      const createBranch = optBool(a.create_branch, "create_branch", false);
      const pr = parsePr(a.pr, "pr");

      const rawFiles = a.files === undefined ? [] : a.files;
      const rawMoves = a.moves === undefined ? [] : a.moves;
      const rawDeletes = a.deletions === undefined ? [] : a.deletions;
      if (!Array.isArray(rawFiles) || !Array.isArray(rawMoves) || !Array.isArray(rawDeletes)) {
        throw new UserError("files/moves/deletions must be arrays");
      }
      const count = rawFiles.length + rawMoves.length + rawDeletes.length;
      if (count === 0) throw new UserError("nothing to commit");
      if (count > MAX_FILES) throw new UserError(`at most ${MAX_FILES} changes per commit`);

      const seen = new Set<string>();
      const claim = (p: string) => {
        const key = p.toLowerCase();
        if (seen.has(key)) throw new UserError(`duplicate path in one commit: ${p}`);
        seen.add(key);
      };

      const writes = rawFiles.map((f, i) => {
        const o = asObject(f, `files[${i}]`);
        const path = validateFilePath(o.path);
        const hasContent = o.content !== undefined;
        const hasEdits = o.edits !== undefined;
        if (hasContent === hasEdits) {
          throw new UserError(`files[${i}] (${path}): provide exactly one of content (full file) or edits (patch)`);
        }
        const content = hasContent ? reqString(o.content, `files[${i}].content`, 0, MAX_FILE_CHARS) : undefined;
        const edits: Edit[] | undefined = hasEdits ? parseEdits(o.edits, `files[${i}].edits`, MAX_FILE_CHARS) : undefined;
        const expected = optString(o.expected_sha, `files[${i}].expected_sha`, 40);
        if (expected !== undefined && !/^[0-9a-f]{7,40}$/i.test(expected)) throw new UserError(`files[${i}].expected_sha: 7-40 hex chars`);
        claim(path);
        return { path, content, edits, expected: expected?.toLowerCase() };
      });
      const moves = rawMoves.map((m, i) => {
        const o = asObject(m, `moves[${i}]`);
        const from = validateFilePath(o.from);
        const to = validateFilePath(o.to);
        claim(from);
        claim(to);
        return { from, to };
      });
      const deletes = rawDeletes.map((d) => {
        const path = validateFilePath(d);
        claim(path);
        return path;
      });

      // Read from the branch if it exists; otherwise (create_branch) from the default branch.
      let head: { commitSha: string; treeSha: string };
      let isNew = false;
      try {
        head = await gh.branchHead(branch);
      } catch (e) {
        if (!(e instanceof BranchMissing)) throw e;
        if (!createBranch) {
          throw new UserError(`branch "${branch}" does not exist; set create_branch: true to create it from ${cfg.defaultBranch}`);
        }
        head = await gh.branchHead(cfg.defaultBranch);
        isNew = true;
      }
      const { tree: existing, truncated } = await gh.getTree(head.treeSha);
      const byPath = new Map<string, TreeEntry>(existing.map((e) => [e.path, e]));
      const missingNote = truncated ? " (tree was truncated by GitHub)" : "";

      const entries: Record<string, unknown>[] = [];
      const report: string[] = [];

      const resolved = await Promise.all(
        writes.map(async (w) => {
          const cur = byPath.get(w.path);
          if (cur && (cur.type !== "blob" || cur.mode === "120000")) {
            throw new UserError(`${w.path}: refusing to overwrite a symlink/submodule/directory`);
          }
          if (w.expected && !(cur && cur.sha.startsWith(w.expected))) {
            throw new UserError(`${w.path}: expected_sha does not match the current file (changed or missing on ${branch}); re-read it with file_get`);
          }
          if (w.content !== undefined) {
            return { w, cur, content: w.content, original: undefined as string | undefined, note: `${cur ? "overwritten" : "created"}, ${countLines(w.content)} lines` };
          }
          if (!cur) throw new UserError(`${w.path}: cannot patch, file does not exist on ${branch}${missingNote}; use content to create it`);
          if ((cur.size ?? 0) > MAX_FILE_CHARS) throw new UserError(`${w.path}: too large to patch (${cur.size} bytes)`);
          const blob = await gh.request<{ content: string }>("GET", `/git/blobs/${cur.sha}`);
          const text = bytesToUtf8(blob.content);
          if (text === null) throw new UserError(`${w.path}: binary file, cannot patch`);
          const res = applyEdits(text, w.edits!, w.path);
          return { w, cur, content: res.text, original: text as string | undefined, note: `patched, ${res.replacements} replacement(s), ${countLines(text)}→${countLines(res.text)} lines` };
        }),
      );

      let total = 0;
      for (const r of resolved) {
        if (r.content.length > MAX_FILE_CHARS) throw new UserError(`${r.w.path}: result too large (max ${MAX_FILE_CHARS} chars)`);
        total += r.content.length;
        entries.push({ path: r.w.path, mode: r.cur?.mode ?? REGULAR_FILE, type: "blob", content: r.content });
        report.push(`- ${r.w.path}: ${r.note}`);
      }
      if (total > MAX_TOTAL_CHARS) throw new UserError(`total content too large (max ${MAX_TOTAL_CHARS} chars)`);

      // Built-in validation: catches broken output now, instead of a read-back round trip later.
      const problems: string[] = [];
      const warnings: string[] = [];
      for (const r of resolved) {
        for (const issue of checkContent(r.w.path, r.content, r.original)) {
          (issue.level === "error" ? problems : warnings).push(`${r.w.path}: ${issue.msg}`);
        }
      }
      if (problems.length > 0) {
        throw new UserError(`Nothing was committed. Validation failed:\n${problems.slice(0, 5).map((p) => `- ${p}`).join("\n")}`);
      }

      for (const m of moves) {
        const cur = byPath.get(m.from);
        if (!cur) throw new UserError(`${m.from}: cannot move, path does not exist on ${branch}${missingNote}`);
        if (cur.type !== "blob" || cur.mode === "120000") throw new UserError(`${m.from}: can only move regular files`);
        if (byPath.has(m.to)) throw new UserError(`${m.to}: move destination already exists`);
        entries.push({ path: m.from, mode: cur.mode, type: "blob", sha: null });
        entries.push({ path: m.to, mode: cur.mode, type: "blob", sha: cur.sha });
        report.push(`- ${m.from} → ${m.to}: moved`);
      }
      for (const p of deletes) {
        const cur = byPath.get(p);
        if (!cur && !truncated) throw new UserError(`${p}: cannot delete, path does not exist on ${branch}`);
        if (cur && cur.type !== "blob") throw new UserError(`${p}: can only delete regular files`);
        entries.push({ path: p, mode: cur?.mode ?? REGULAR_FILE, type: "blob", sha: null });
        report.push(`- ${p}: deleted`);
      }

      const newTree = await gh.request<{ sha: string }>("POST", "/git/trees", { base_tree: head.treeSha, tree: entries });
      const commit = await gh.request<{ sha: string }>("POST", "/git/commits", {
        message: `${message}\n\nVia github-mcp-secure`,
        tree: newTree.sha,
        parents: [head.commitSha],
      });
      // A new branch is created pointing straight at the commit, so a failed edit never leaves an empty branch.
      if (isNew) await gh.request("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: commit.sha });
      else await gh.request("PATCH", `/git/refs/heads/${encPath(branch)}`, { sha: commit.sha, force: false });

      const lines = [`Committed ${commit.sha.slice(0, 7)} to ${branch}${isNew ? ` (new branch from ${cfg.defaultBranch})` : ""}:`, ...report];
      if (warnings.length > 0) lines.push("Warnings:", ...warnings.map((w) => `- ${w}`));
      if (pr) {
        try {
          lines.push(await openPr(gh, cfg, branch, pr));
        } catch (e) {
          const why = e instanceof UserError ? e.message : "internal error";
          lines.push(`PR step failed (${why}); the commit is on ${branch}. Retry with pr_create.`);
        }
      }
      return lines.join("\n");
    },
  },
  {
    name: "pr_create",
    description:
      "Open a pull request from a working branch into the default branch (returns the existing PR if one is already open for that branch). " +
      "push_files can do this in the same call via its pr option. It is NEVER merged by this server; a human must review and merge.",
    inputSchema: {
      type: "object",
      properties: {
        head: { type: "string", description: "Working branch (allowed prefix)." },
        title: { type: "string" },
        body: { type: "string" },
        draft: { type: "boolean", description: "Open as a draft PR." },
      },
      required: ["head", "title"],
      additionalProperties: false,
    },
    annotations: { ...writeNonDestructive, idempotentHint: true },
    async run(gh, cfg, a) {
      const head = validateWritableBranch(a.head, cfg.prefix, cfg.defaultBranch, "head");
      const pr = parsePr({ title: a.title, body: a.body, draft: a.draft }, "pr")!;
      return openPr(gh, cfg, head, pr);
    },
  },
  {
    name: "prs_list",
    description: "List pull requests (default: open).",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed", "all"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    annotations: readOnly,
    async run(gh, _cfg, a) {
      const state = a.state === undefined ? "open" : a.state;
      if (state !== "open" && state !== "closed" && state !== "all") throw new UserError("state: open|closed|all");
      const limit = optInt(a.limit, "limit", 1, 50, 20);
      const prs = await gh.request<{ number: number; title: string; state: string; draft: boolean; head: { ref: string }; user: { login: string } }[]>(
        "GET",
        `/pulls?state=${state}&per_page=${limit}`,
      );
      return json(prs.map((p) => ({ number: p.number, title: p.title, state: p.state, draft: p.draft, branch: p.head.ref, author: p.user.login })));
    },
  },
  {
    name: "pr_get",
    description: "Get a pull request's details and changed files (with truncated patches).",
    inputSchema: {
      type: "object",
      properties: { number: { type: "integer", minimum: 1 } },
      required: ["number"],
      additionalProperties: false,
    },
    annotations: readOnly,
    async run(gh, _cfg, a) {
      const n = optInt(a.number, "number", 1, 10_000_000, 0);
      if (n === 0) throw new UserError("number: required");
      const pr = await gh.request<{
        number: number; title: string; body: string | null; state: string; draft: boolean; merged: boolean; mergeable_state?: string;
        head: { ref: string }; base: { ref: string }; html_url: string;
      }>("GET", `/pulls/${n}`);
      const files = await gh.request<{ filename: string; status: string; additions: number; deletions: number; patch?: string }[]>(
        "GET",
        `/pulls/${n}/files?per_page=100`,
      );
      return truncate(
        json({
          number: pr.number, title: pr.title, state: pr.state, draft: pr.draft, merged: pr.merged,
          head: pr.head.ref, base: pr.base.ref, url: pr.html_url, mergeable_state: pr.mergeable_state,
          body: truncate(pr.body ?? "", 5000),
          files: files.map((f) => ({ file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: truncate(f.patch ?? "", 4000) })),
        }),
      );
    },
  },
];

export { GitHubError };
