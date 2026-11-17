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
