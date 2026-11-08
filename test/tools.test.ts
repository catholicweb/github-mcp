import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, countLines, renderFile } from "../src/edit.ts";
import { BranchMissing, GitHubError } from "../src/github.ts";
import { globToRegExp } from "../src/search.ts";
import { tools, type Config } from "../src/tools.ts";
import { UserError } from "../src/validate.ts";

const cfg: Config = { repo: "me/repo", defaultBranch: "main", prefix: "claude/" };
const b64 = (s: string) => Buffer.from(s).toString("base64");
const edit = (old_str: string, new_str: string, replace_all = false) => ({ old_str, new_str, replace_all });

// --- edit helpers -----------------------------------------------------------
test("applyEdits: unique match, replace_all, literal $, ordering, all-or-none", () => {
  assert.deepEqual(applyEdits("a b c", [edit("b", "X")], "f"), { text: "a X c", replacements: 1 });
  assert.equal(applyEdits("a a a", [edit("a", "z", true)], "f").replacements, 3);
  assert.equal(applyEdits("price", [edit("price", "$& $1")], "f").text, "$& $1"); // no regex replacement patterns
  assert.equal(applyEdits("one", [edit("one", "two"), edit("two", "three")], "f").text, "three"); // in order
  assert.throws(() => applyEdits("a a", [edit("a", "b")], "f"), /matches 2 places/);
  assert.throws(() => applyEdits("abc", [edit("zzz", "b")], "f"), /not found/);
  assert.throws(() => applyEdits("abc", [edit("a", "a")], "f"), /no change/);
  assert.throws(() => applyEdits("abc", [edit("a", "x"), edit("zzz", "y")], "f"), UserError); // second fails -> whole call fails
});

test("renderFile: header, ranges, line numbers, cap with continuation", () => {
  const text = "l1\nl2\nl3\nl4\n";
  const info = { path: "a.txt", branch: "main", sha: "abcdef1234" };
  assert.equal(countLines(text), 4);
  assert.equal(renderFile(info, text, { start: 0, end: 0, numbered: false }), "# a.txt @ main · blob abcdef1 · 4 lines\n\nl1\nl2\nl3\nl4");
  assert.equal(
    renderFile(info, text, { start: 2, end: 3, numbered: true }),
    "# a.txt @ main · blob abcdef1 · 4 lines · showing 2-3\n\n2\tl2\n3\tl3",
  );
  assert.throws(() => renderFile(info, text, { start: 9, end: 0, numbered: false }), /past the end/);
  const capped = renderFile(info, text, { start: 0, end: 0, numbered: false }, 8);
  assert.match(capped, /showing 1-2/);
  assert.match(capped, /continue with start_line=3/);
});

// --- fake GitHub ------------------------------------------------------------
type Req = { method: string; path: string; body?: any };
function fakeGh(opts: { files?: Record<string, { sha: string; mode?: string; text: string }>; branches?: string[]; prs?: any[] } = {}) {
  const reqs: Req[] = [];
  const files = opts.files ?? {};
  const branches = new Set(opts.branches ?? ["main"]);
  const gh = {
    reqs,
    async branchHead(b: string) {
      if (!branches.has(b)) throw new BranchMissing(`branch "${b}" does not exist`);
      return { commitSha: `c-${b}`, treeSha: `t-${b}` };
    },
    async getTree() {
      return { truncated: false, tree: Object.entries(files).map(([path, f]) => ({ path, mode: f.mode ?? "100644", type: "blob", sha: f.sha, size: f.text.length })) };
    },
    async request(method: string, path: string, body?: unknown) {
      reqs.push({ method, path, body });
      if (method === "GET" && path.startsWith("/git/blobs/")) {
        const f = Object.values(files).find((x) => x.sha === path.split("/").pop());
        return { content: b64(f!.text), encoding: "base64" };
      }
      if (method === "GET" && path.startsWith("/pulls?")) return opts.prs ?? [];
      if (method === "POST" && path === "/git/trees") return { sha: "t-new" };
      if (method === "POST" && path === "/git/commits") return { sha: "c0ffee1234" };
      if (method === "POST" && path === "/pulls") return { number: 9, html_url: "https://github.com/me/repo/pull/9" };
      return {};
    },
  };
  return gh;
}
const tool = (name: string) => tools.find((t) => t.name === name)!;
const push = (gh: ReturnType<typeof fakeGh>, args: Record<string, unknown>) => tool("push_files").run(gh as any, cfg, args);

// --- push_files: patch ------------------------------------------------------
test("push_files patches a file server-side without resending content, keeps mode", async () => {
  const gh = fakeGh({ files: { "run.sh": { sha: "aaa1111", mode: "100755", text: "echo one\necho two\n" } }, branches: ["main", "claude/x"] });
  const out = await push(gh, { branch: "claude/x", message: "m", files: [{ path: "run.sh", edits: [{ old_str: "two", new_str: "2" }] }] });
  const tree = gh.reqs.find((r) => r.path === "/git/trees")!.body.tree;
  assert.deepEqual(tree, [{ path: "run.sh", mode: "100755", type: "blob", content: "echo one\necho 2\n" }]);
  assert.match(out, /Committed c0ffee1 to claude\/x:/);
  assert.match(out, /- run\.sh: patched, 1 replacement\(s\), 2→2 lines/);
  assert.ok(gh.reqs.some((r) => r.method === "PATCH" && r.body.force === false));
});

test("push_files rejects bad patches and mixed/missing content before committing", async () => {
  const gh = fakeGh({ files: { "a.txt": { sha: "aaa1111", text: "x x" } }, branches: ["main", "claude/x"] });
  const base = { branch: "claude/x", message: "m" };
  await assert.rejects(push(gh, { ...base, files: [{ path: "a.txt", edits: [{ old_str: "x", new_str: "y" }] }] }), /matches 2 places/);
  await assert.rejects(push(gh, { ...base, files: [{ path: "a.txt", edits: [{ old_str: "q", new_str: "y" }] }] }), /not found/);
  await assert.rejects(push(gh, { ...base, files: [{ path: "nope.txt", edits: [{ old_str: "q", new_str: "y" }] }] }), /does not exist/);
  await assert.rejects(push(gh, { ...base, files: [{ path: "a.txt" }] }), /exactly one of content/);
  await assert.rejects(push(gh, { ...base, files: [{ path: "a.txt", content: "z", edits: [{ old_str: "x", new_str: "y" }] }] }), /exactly one of content/);
  await assert.rejects(push(gh, { ...base, files: [{ path: "a.txt", content: "z", expected_sha: "bbb2222" }] }), /expected_sha/);
  assert.ok(!gh.reqs.some((r) => r.method !== "GET"), "no write call may happen after a failed validation");
});

// --- push_files: branch + PR in one call -------------------------------------
test("create_branch + pr: one commit, branch created at the commit, PR opened", async () => {
  const gh = fakeGh({ files: { "a.txt": { sha: "aaa1111", text: "hello" } } });
  const out = await push(gh, {
    branch: "claude/fix",
    message: "fix",
    create_branch: true,
    files: [{ path: "a.txt", edits: [{ old_str: "hello", new_str: "hi" }] }],
    pr: { title: "Fix", body: "why", draft: true },
  });
  const ref = gh.reqs.find((r) => r.path === "/git/refs")!;
  assert.deepEqual(ref.body, { ref: "refs/heads/claude/fix", sha: "c0ffee1234" });
  assert.ok(gh.reqs.findIndex((r) => r.path === "/git/commits") < gh.reqs.findIndex((r) => r.path === "/git/refs"));
  assert.equal(gh.reqs.find((r) => r.path === "/git/commits")!.body.parents[0], "c-main");
  const pr = gh.reqs.find((r) => r.method === "POST" && r.path === "/pulls")!;
  assert.deepEqual([pr.body.base, pr.body.head, pr.body.draft], ["main", "claude/fix", true]);
  assert.match(out, /new branch from main/);
  assert.match(out, /Opened PR #9/);
});

test("a failed edit on a new branch leaves no branch behind; missing branch needs create_branch", async () => {
  const gh = fakeGh({ files: { "a.txt": { sha: "aaa1111", text: "hello" } } });
  await assert.rejects(push(gh, { branch: "claude/fix", message: "m", create_branch: true, files: [{ path: "a.txt", edits: [{ old_str: "zzz", new_str: "y" }] }] }), /not found/);
  assert.ok(!gh.reqs.some((r) => r.path === "/git/refs"));
  await assert.rejects(push(gh, { branch: "claude/fix", message: "m", files: [{ path: "a.txt", content: "x" }] }), /create_branch: true/);
});

test("pr step failure is reported without hiding the successful commit; existing PR is reused", async () => {
  const gh = fakeGh({ files: { "a.txt": { sha: "aaa1111", text: "hello" } }, branches: ["main", "claude/x"], prs: [{ number: 3, html_url: "https://github.com/me/repo/pull/3" }] });
  const out = await push(gh, { branch: "claude/x", message: "m", files: [{ path: "a.txt", content: "new" }], pr: { title: "t" } });
  assert.match(out, /PR #3 already open/);
  assert.ok(!gh.reqs.some((r) => r.method === "POST" && r.path === "/pulls"));
});

// --- push_files: moves --------------------------------------------------------
test("moves rename by blob sha without resending content", async () => {
  const gh = fakeGh({ files: { "old.ts": { sha: "bbb2222", mode: "100755", text: "x" } }, branches: ["main", "claude/x"] });
  await push(gh, { branch: "claude/x", message: "mv", moves: [{ from: "old.ts", to: "src/new.ts" }] });
  const tree = gh.reqs.find((r) => r.path === "/git/trees")!.body.tree;
  assert.deepEqual(tree, [
    { path: "old.ts", mode: "100755", type: "blob", sha: null },
    { path: "src/new.ts", mode: "100755", type: "blob", sha: "bbb2222" },
  ]);
  await assert.rejects(push(gh, { branch: "claude/x", message: "mv", moves: [{ from: "missing.ts", to: "z.ts" }] }), /does not exist/);
  await assert.rejects(push(gh, { branch: "claude/x", message: "mv", moves: [{ from: "old.ts", to: ".github/x.yml" }] }), /protected/);
});

// --- pr_create / file_get -------------------------------------------------------
test("pr_create is idempotent", async () => {
  const gh = fakeGh({ prs: [{ number: 5, html_url: "https://github.com/me/repo/pull/5" }] });
  const out = await tool("pr_create").run(gh as any, cfg, { head: "claude/x", title: "t" });
  assert.match(out, /already open.*pull\/5/);
  assert.ok(!gh.reqs.some((r) => r.method === "POST"));
});

test("file_get returns a header and honours line ranges", async () => {
  const gh: any = {
    async request(_m: string, path: string) {
      if (path.startsWith("/contents/")) return { type: "file", sha: "abcdef1234", size: 12, path: "f.txt" };
      return { content: b64("a\nb\nc\nd\n"), encoding: "base64" };
    },
  };
  const out = await tool("file_get").run(gh, cfg, { path: "f.txt", start_line: 2, end_line: 3 });
  assert.equal(out, "# f.txt @ main · blob abcdef1 · 4 lines · showing 2-3\n\nb\nc");
  await assert.rejects(tool("file_get").run(gh, cfg, { path: "f.txt", start_line: 3, end_line: 2 }), /end_line/);
});

// --- grep ---------------------------------------------------------------------
const grepFiles = {
  "src/a.ts": { sha: "s1", text: "alpha\nbeta\nGamma\n" },
  "src/b.ts": { sha: "s2", text: "beta beta\n" },
  "README.md": { sha: "s3", text: "beta in readme\n" },
  "img.png": { sha: "s4", text: "beta" },
  "package-lock.json": { sha: "s5", text: "beta" },
};
const grep = (gh: any, args: Record<string, unknown>) => tool("grep").run(gh, cfg, args);

test("grep: glob, context, case, limits, and skipped files are never downloaded", async () => {
  const gh = fakeGh({ files: grepFiles });
  assert.equal(await grep(gh, { pattern: "beta", glob: "*.ts" }), "2 matches in 2 files (scanned 2)\nsrc/a.ts:2:beta\nsrc/b.ts:1:beta beta");
  assert.equal(
    await grep(gh, { pattern: "beta", glob: "src/a.ts", context: 1 }),
    "1 match in 1 file (scanned 1)\nsrc/a.ts-1-alpha\nsrc/a.ts:2:beta\nsrc/a.ts-3-Gamma",
  );
  assert.match(await grep(gh, { pattern: "BETA", ignore_case: true }), /^3 matches in 3 files \(scanned 3\); 2 binary\/large\/lock files skipped/);
  assert.ok(!gh.reqs.some((r) => r.path.endsWith("/s4") || r.path.endsWith("/s5")));
  assert.match(await grep(gh, { pattern: "a.b", literal: true }), /^0 matches/);
  assert.match(await grep(gh, { pattern: "al", path_prefix: "src/" }), /^1 match in 1 file/);
  assert.match(await grep(gh, { pattern: "beta", max_results: 1 }), /^1 match in 1 file .*stopped at max_results/);
  await assert.rejects(grep(gh, { pattern: "(" }), /invalid regex/);
});

test("globToRegExp", () => {
  const m = (g: string, p: string) => globToRegExp(g).test(p);
  assert.ok(m("*.ts", "src/deep/a.ts") && !m("*.ts", "a.tsx"));
  assert.ok(m("src/*.ts", "src/a.ts") && !m("src/*.ts", "src/x/a.ts"));
  assert.ok(m("**/*.{js,ts}", "a/b/c.js") && m("**/*.{js,ts}", "c.ts") && !m("**/*.{js,ts}", "c.md"));
  assert.ok(m("docs/**", "docs/a/b.md") && !m("docs/**", "other/a.md"));
  assert.ok(m("a?c.txt", "abc.txt") && !m("a?c.txt", "a/c.txt"));
});

// --- file_get: several files ---------------------------------------------------
test("file_get paths: one call, per-file errors inline, inline content needs no blob request", async () => {
  const reqs: string[] = [];
  const gh: any = {
    async request(_m: string, path: string) {
      reqs.push(path);
      if (path.includes("nope.txt")) throw new GitHubError(404, "Not Found");
      if (path.startsWith("/contents/src")) return [{ type: "file", name: "a.ts", path: "src/a.ts", size: 3 }];
      if (path.startsWith("/contents/inline.txt")) return { type: "file", sha: "1111111aaa", size: 4, path: "inline.txt", content: b64("x\ny\n"), encoding: "base64" };
      if (path.startsWith("/contents/")) return { type: "file", sha: "2222222bbb", size: 4, path: "f.txt" };
      return { content: b64("a\nb\n"), encoding: "base64" };
    },
  };
  const get = (args: Record<string, unknown>) => tool("file_get").run(gh, cfg, args);
  assert.equal(await get({ path: "inline.txt" }), "# inline.txt @ main · blob 1111111 · 2 lines\n\nx\ny");
  assert.equal(reqs.length, 1);
  const out = await get({ paths: ["inline.txt", "f.txt", "nope.txt", "src"] });
  assert.equal(
    out,
    [
      "# inline.txt @ main · blob 1111111 · 2 lines\n\nx\ny",
      "# f.txt @ main · blob 2222222 · 2 lines\n\na\nb",
      "# nope.txt: ERROR: GitHub API 404: Not Found",
      "# src (directory)\n\nfile\t3\tsrc/a.ts",
    ].join("\n\n"),
  );
  await assert.rejects(get({ path: "a", paths: ["b"] }), /either path or paths/);
  await assert.rejects(get({ paths: ["../x"] }), /invalid/);
  await assert.rejects(get({}), /path/);
});

// --- built-in validation ---------------------------------------------------------
test("push_files validation: broken JSON blocks the commit; pre-existing breakage, JSONC and conflict markers only warn", async () => {
  const gh = fakeGh({
    files: { "package.json": { sha: "p1", text: '{"a": 1}' }, "broken.json": { sha: "p2", text: "{ already broken" } },
    branches: ["main", "claude/x"],
  });
  const base = { branch: "claude/x", message: "m" };
  await assert.rejects(push(gh, { ...base, files: [{ path: "package.json", edits: [{ old_str: '"a": 1', new_str: '"a": 1,' }] }, { path: "ok.txt", content: "fine" }] }), /Nothing was committed.*package\.json: invalid JSON/s);
  await assert.rejects(push(gh, { ...base, files: [{ path: "new.json", content: "{ nope" }] }), /new\.json: invalid JSON/);
  await assert.rejects(push(gh, { ...base, files: [{ path: "n.txt", content: "a\u0000b" }] }), /NUL byte/);
  assert.ok(!gh.reqs.some((r) => r.method !== "GET"), "nothing may be written after a failed validation");

  const out = await push(gh, {
    ...base,
    files: [
      { path: "broken.json", edits: [{ old_str: "already", new_str: "still" }] },
      { path: "tsconfig.json", content: "{ // comment\n}" },
      { path: "c.txt", content: "<<<<<<< a\nx\n>>>>>>> b\n" },
    ],
  });
  assert.match(out, /Warnings:/);
  assert.match(out, /broken\.json: invalid JSON/);
  assert.match(out, /tsconfig\.json: invalid JSON/);
  assert.match(out, /c\.txt: contains merge conflict markers/);
  assert.ok(gh.reqs.some((r) => r.path === "/git/trees"));
});
