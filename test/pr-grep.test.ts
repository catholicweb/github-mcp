import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubError } from "../src/github.ts";
import { tools, type Config } from "../src/tools.ts";

const cfg: Config = { repo: "me/repo", defaultBranch: "main", prefix: "claude/" };
const b64 = (s: string) => Buffer.from(s).toString("base64");
const tool = (name: string) => tools.find((t) => t.name === name)!;
type Req = { method: string; path: string; body?: any };

// Minimal fake GitHub: a flat set of files on `main`.
function fakeGh(opts: { files: Record<string, { sha: string; text: string }> }) {
  return {
    async branchHead() {
      return { commitSha: "c", treeSha: "t" };
    },
    async getTree() {
      return { truncated: false, tree: Object.entries(opts.files).map(([path, f]) => ({ path, mode: "100644", type: "blob", sha: f.sha, size: f.text.length })) };
    },
    async request(_m: string, path: string) {
      const f = Object.values(opts.files).find((x) => x.sha === path.split("/").pop());
      return { content: b64(f!.text), encoding: "base64" };
    },
  };
}

// --- grep: partial results + offset -----------------------------------------
test("grep flags a partial scan and continues with offset", async () => {
  const files: Record<string, { sha: string; text: string }> = {};
  for (let i = 0; i < 45; i++) files[`f${String(i).padStart(2, "0")}.txt`] = { sha: `s${i}`, text: i === 44 ? "needle\n" : "hay\n" };
  const gh = fakeGh({ files });
  const first = await tool("grep").run(gh as any, cfg, { pattern: "needle" });
  assert.match(first, /^PARTIAL: 0 matches/);
  assert.match(first, /files 1-40 of 45 were scanned; 5 not scanned/);
  assert.match(first, /offset=40/);
  const next = await tool("grep").run(gh as any, cfg, { pattern: "needle", offset: 40 });
  assert.match(next, /^1 match in 1 file/);
  assert.match(next, /f44\.txt:1:needle/);
});

test("grep over a small repo is not marked partial", async () => {
  const gh = fakeGh({ files: { "a.txt": { sha: "s1", text: "needle\n" } } });
  assert.match(await tool("grep").run(gh as any, cfg, { pattern: "needle" }), /^1 match in 1 file/);
});

// --- pr_get checks / pr_update ---------------------------------------------
function prGh(pr: any, checks: "ok" | "denied" = "ok") {
  const reqs: Req[] = [];
  return {
    reqs,
    async request(method: string, path: string, body?: unknown) {
      reqs.push({ method, path, body });
      if (path === "/pulls/5") return pr;
      if (path.startsWith("/pulls/5/files")) return [];
      if (path.includes("/check-runs")) {
        if (checks === "denied") throw new GitHubError(403, "Resource not accessible");
        return { check_runs: [{ name: "test", status: "completed", conclusion: "failure" }, { name: "lint", status: "completed", conclusion: "success" }] };
      }
      if (path.endsWith("/status")) return { state: "pending", statuses: [] };
      return {};
    },
  };
}
const openPr = (over: any = {}) => ({
  number: 5, title: "t", body: "b", state: "open", draft: false, merged: false,
  head: { ref: "claude/x", sha: "abc", repo: { full_name: "me/repo" } }, base: { ref: "main" }, html_url: "u", ...over,
});

test("pr_get reports CI checks, and degrades when the token cannot read them", async () => {
  const ok = JSON.parse(await tool("pr_get").run(prGh(openPr()) as any, cfg, { number: 5 }));
  assert.equal(ok.checks.state, "failing");
  assert.deepEqual(ok.checks.items.map((i: any) => i.name), ["test", "lint"]);
  const denied = JSON.parse(await tool("pr_get").run(prGh(openPr(), "denied") as any, cfg, { number: 5 }));
  assert.match(denied.checks, /token cannot read checks/);
});

test("pr_update edits title/body of an open working-branch PR only", async () => {
  const gh = prGh(openPr());
  const out = await tool("pr_update").run(gh as any, cfg, { number: 5, body: "new" });
  assert.match(out, /Updated PR #5: body/);
  assert.deepEqual(gh.reqs.find((r) => r.method === "PATCH")!.body, { body: "new" });
  await assert.rejects(() => tool("pr_update").run(prGh(openPr({ head: { ref: "feature/y", repo: { full_name: "me/repo" } } })) as any, cfg, { number: 5, title: "x" }), /refusing to edit/);
  await assert.rejects(() => tool("pr_update").run(prGh(openPr({ head: { ref: "claude/x", repo: { full_name: "evil/fork" } } })) as any, cfg, { number: 5, title: "x" }), /refusing to edit/);
  await assert.rejects(() => tool("pr_update").run(prGh(openPr({ state: "closed" })) as any, cfg, { number: 5, title: "x" }), /not open/);
  await assert.rejects(() => tool("pr_update").run(prGh(openPr()) as any, cfg, { number: 5 }), /title and\/or a body/);
});

// --- repo_tree: collapse big repos -------------------------------------------
function treeGh(paths: string[]) {
  return {
    async branchHead() {
      return { commitSha: "c", treeSha: "t" };
    },
    async getTree() {
      return { truncated: false, tree: paths.map((path, i) => ({ path, mode: "100644", type: "blob", sha: `s${i}`, size: 10 })) };
    },
  };
}

test("repo_tree lists small repos in full and collapses big ones to directories", async () => {
  const small = await tool("repo_tree").run(treeGh(["a.txt", "src/b.ts"]) as any, cfg, {});
  assert.match(small, /^2 files\n/);
  assert.match(small, /src\/b\.ts\t10/);

  const big = Array.from({ length: 400 }, (_, i) => `images/comic/f${i}.webp`).concat(["README.md", "src/a/x.ts", "src/a/y.ts"]);
  const out = await tool("repo_tree").run(treeGh(big) as any, cfg, {});
  assert.match(out, /^403 files in 3 entries; collapsed to depth 2 because it is big/);
  assert.match(out, /images\/comic\/\t400 files, 4000 bytes/);
  assert.match(out, /src\/a\/\t2 files/);
  assert.match(out, /README\.md\t10/);

  // path_prefix + explicit depth expands one level at a time; a small prefix is listed in full
  const one = await tool("repo_tree").run(treeGh(big) as any, cfg, { path_prefix: "images/", depth: 1 });
  assert.match(one, /images\/comic\/\t400 files/);
  const full = await tool("repo_tree").run(treeGh(big.slice(0, 5).concat(["src/a/x.ts"])) as any, cfg, { path_prefix: "src/" });
  assert.match(full, /^1 files\nsrc\/a\/x\.ts\t10/);
});

// --- pr_get: patches only for open PRs by default -----------------------------
test("pr_get skips patches for merged PRs unless asked", async () => {
  const files = [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }];
  const mk = (pr: any) => ({
    async request(_m: string, path: string) {
      if (path === "/pulls/5") return pr;
      if (path.startsWith("/pulls/5/files")) return files;
      if (path.includes("/check-runs")) return { check_runs: [] };
      if (path.endsWith("/status")) return { state: "success", statuses: [] };
      return {};
    },
  });
  const merged = JSON.parse(await tool("pr_get").run(mk(openPr({ state: "closed", merged: true })) as any, cfg, { number: 5 }));
  assert.equal(merged.files[0].patch, undefined);
  assert.equal(merged.files[0].additions, 1);
  const forced = JSON.parse(await tool("pr_get").run(mk(openPr({ state: "closed", merged: true })) as any, cfg, { number: 5, patches: true }));
  assert.match(forced.files[0].patch, /\+x/);
  const open = JSON.parse(await tool("pr_get").run(mk(openPr()) as any, cfg, { number: 5 }));
  assert.match(open.files[0].patch, /\+x/);
  const off = JSON.parse(await tool("pr_get").run(mk(openPr()) as any, cfg, { number: 5, patches: false }));
  assert.equal(off.files[0].patch, undefined);
});
