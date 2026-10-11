import { GitHub, GitHubError, bytesToUtf8, encPath, type TreeEntry } from "./github.ts";
import {
  UserError,
  asObject,
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

const json = (v: unknown) => JSON.stringify(v, null, 2);

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const writeNonDestructive = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

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
    description: "Read a text file from a branch. If the path is a directory, lists its entries.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        branch: { type: "string", description: "Defaults to the repo default branch." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: readOnly,
    async run(gh, cfg, a) {
      const path = reqString(a.path, "path", 1, 400);
      if (path.includes("..") || path.startsWith("/")) throw new UserError("path: invalid");
      const branch = validateBranchName(a.branch ?? cfg.defaultBranch);
      const meta = await gh.request<
        | { type: "file"; sha: string; size: number; path: string }
        | { type: string; name: string; path: string; size: number }[]
      >("GET", `/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`);
      if (Array.isArray(meta)) return meta.map((e) => `${e.type}\t${e.size}\t${e.path}`).join("\n");
      if (meta.type !== "file") throw new UserError(`${path} is a ${meta.type}, not a regular file`);
      const blob = await gh.request<{ content: string; encoding: string }>("GET", `/git/blobs/${meta.sha}`);
      const text = bytesToUtf8(blob.content);
      if (text === null) return `${path} is a binary file (${meta.size} bytes); not shown.`;
      return truncate(text);
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
      `Commit one or more file changes to a working branch in a SINGLE commit (add/modify via "files", remove via "deletions"). ` +
      `The branch must already exist (branch_create) and start with the allowed prefix. Fast-forward only; never force. ` +
      `CI/workflow files (.github/, CODEOWNERS, etc.) are blocked. Content must be UTF-8 text.`,
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string" },
        message: { type: "string", description: "Commit message." },
        files: {
          type: "array",
          description: "Files to create or overwrite (full new content).",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
        deletions: { type: "array", description: "Paths to delete.", items: { type: "string" } },
      },
      required: ["branch", "message"],
      additionalProperties: false,
    },
    annotations: writeNonDestructive,
    async run(gh, cfg, a) {
      const branch = validateWritableBranch(a.branch, cfg.prefix, cfg.defaultBranch);
      const message = reqString(a.message, "message", 1, 2000);

      const rawFiles = a.files === undefined ? [] : a.files;
      const rawDeletes = a.deletions === undefined ? [] : a.deletions;
      if (!Array.isArray(rawFiles) || !Array.isArray(rawDeletes)) throw new UserError("files/deletions must be arrays");
      if (rawFiles.length + rawDeletes.length === 0) throw new UserError("nothing to commit");
      if (rawFiles.length + rawDeletes.length > MAX_FILES) throw new UserError(`at most ${MAX_FILES} changes per commit`);

      const seen = new Set<string>();
      const claim = (p: string) => {
        const key = p.toLowerCase();
        if (seen.has(key)) throw new UserError(`duplicate path in one commit: ${p}`);
        seen.add(key);
      };

      let total = 0;
      const writes = rawFiles.map((f, i) => {
        const o = asObject(f, `files[${i}]`);
        const path = validateFilePath(o.path);
        const content = reqString(o.content, `files[${i}].content`, 0, MAX_FILE_CHARS);
        total += content.length;
        claim(path);
        return { path, content };
      });
      if (total > MAX_TOTAL_CHARS) throw new UserError(`total content too large (max ${MAX_TOTAL_CHARS} chars)`);
      const deletes = rawDeletes.map((d, i) => {
        const path = validateFilePath(d);
        claim(path);
        return path;
      });

      const head = await gh.branchHead(branch);
      const { tree: existing, truncated } = await gh.getTree(head.treeSha);
      const byPath = new Map<string, TreeEntry>(existing.map((e) => [e.path, e]));

      const entries: Record<string, unknown>[] = [];
      for (const w of writes) {
        const cur = byPath.get(w.path);
        if (cur && (cur.type !== "blob" || cur.mode === "120000")) {
          throw new UserError(`${w.path}: refusing to overwrite a symlink/submodule/directory`);
        }
        entries.push({ path: w.path, mode: cur?.mode ?? REGULAR_FILE, type: "blob", content: w.content });
      }
      for (const p of deletes) {
        const cur = byPath.get(p);
        if (!cur && !truncated) throw new UserError(`${p}: cannot delete, path does not exist on ${branch}`);
        if (cur && cur.type !== "blob") throw new UserError(`${p}: can only delete regular files`);
        entries.push({ path: p, mode: cur?.mode ?? REGULAR_FILE, type: "blob", sha: null });
      }

      const newTree = await gh.request<{ sha: string }>("POST", "/git/trees", { base_tree: head.treeSha, tree: entries });
      const commit = await gh.request<{ sha: string }>("POST", "/git/commits", {
        message: `${message}\n\nVia github-mcp-secure`,
        tree: newTree.sha,
        parents: [head.commitSha],
      });
      await gh.request("PATCH", `/git/refs/heads/${encPath(branch)}`, { sha: commit.sha, force: false });
      return `Committed ${commit.sha.slice(0, 7)} to ${branch}: ${writes.length} written, ${deletes.length} deleted.`;
    },
  },
  {
    name: "pr_create",
    description:
      "Open a pull request from a working branch into the default branch. It is NEVER merged by this server; a human must review and merge.",
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
    annotations: writeNonDestructive,
    async run(gh, cfg, a) {
      const head = validateWritableBranch(a.head, cfg.prefix, cfg.defaultBranch, "head");
      const title = reqString(a.title, "title", 1, 256);
      const body = optString(a.body, "body", 20_000) ?? "";
      const draft = optBool(a.draft, "draft", false);
      const pr = await gh.request<{ number: number; html_url: string }>("POST", "/pulls", {
        title,
        head,
        base: cfg.defaultBranch,
        body,
        draft,
        maintainer_can_modify: false,
      });
      return `Opened PR #${pr.number}: ${pr.html_url}`;
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
