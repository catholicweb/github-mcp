import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { resetAccessCache } from "../src/access.ts";
import { validateFilePath, validateWritableBranch, UserError } from "../src/validate.ts";

const TEAM = "https://acme.cloudflareaccess.com";
const AUD = "aud-tag-123";
const baseEnv: Record<string, string> = {
  GITHUB_TOKEN: "ghp_test_token",
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ALLOWED_REPO: "me/repo", // legacy single-repo setting must keep working
  BRANCH_PREFIX: "claude/",
};
let env: Record<string, string> = { ...baseEnv };
const defaultBranches: Record<string, string> = {};

// --- JWT helpers ------------------------------------------------------------
const b64u = (b: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? b : new Uint8Array(b as ArrayBuffer)).toString("base64url");

const genPair = async () =>
  (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
const keyPair = await genPair();
const otherPair = await genPair();
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

async function makeJwt(over: Record<string, unknown> = {}, signWith = keyPair.privateKey, alg = "RS256") {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg, kid: "k1", typ: "JWT" }));
  const payload = b64u(
    JSON.stringify({ iss: TEAM, aud: [AUD], exp: now + 300, iat: now, email: "me@example.com", ...over }),
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signWith, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64u(sig)}`;
}

// --- fetch mock -------------------------------------------------------------
type Call = { method: string; url: string; body?: any; auth?: string | null };
let calls: Call[] = [];
let github: (c: Call) => { status?: number; body: unknown } = () => ({ status: 404, body: { message: "Not Found" } });

beforeEach(() => {
  calls = [];
  env = { ...baseEnv };
  for (const k of Object.keys(defaultBranches)) delete defaultBranches[k];
  resetAccessCache();
  github = () => ({ status: 404, body: { message: "Not Found" } });
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [publicJwk] });
    const headers = new Headers(init.headers);
    const call: Call = {
      method: init.method ?? "GET",
      url,
      body: init.body ? JSON.parse(init.body) : undefined,
      auth: headers.get("authorization"),
    };
    calls.push(call);
    if (!url.startsWith("https://api.github.com/")) throw new Error(`unexpected outbound fetch: ${url}`);
    const root = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/);
    if (root && call.method === "GET") {
      return Response.json({ default_branch: defaultBranches[root[1]!.toLowerCase()] ?? "main" });
    }
    const r = github(call);
    return Response.json(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
});

async function rpc(method: string, params: unknown, opts: { jwt?: string | null; origin?: string; id?: number } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const jwt = opts.jwt === undefined ? await makeJwt() : opts.jwt;
  if (jwt) headers["cf-access-jwt-assertion"] = jwt;
  if (opts.origin) headers.origin = opts.origin;
  const res = await worker.fetch(
    new Request("https://github-mcp.example.com/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: opts.id ?? 1, method, params }),
    }),
    env as any,
  );
  return res;
}
const call = async (name: string, args: unknown) => {
  const res = await rpc("tools/call", { name, arguments: args });
  assert.equal(res.status, 200);
  const j: any = await res.json();
  return { text: j.result.content[0].text as string, isError: !!j.result.isError };
};

// --- auth -------------------------------------------------------------------
test("rejects missing, forged, wrong-aud, expired, wrong-alg and wrong-email tokens", async () => {
  assert.equal((await rpc("tools/list", {}, { jwt: null })).status, 403);
  assert.equal((await rpc("tools/list", {}, { jwt: await makeJwt({}, otherPair.privateKey) })).status, 403);
  assert.equal((await rpc("tools/list", {}, { jwt: await makeJwt({ aud: ["other"] }) })).status, 403);
  assert.equal((await rpc("tools/list", {}, { jwt: await makeJwt({ exp: 1 }) })).status, 403);
  assert.equal((await rpc("tools/list", {}, { jwt: await makeJwt({ iss: "https://evil.cloudflareaccess.com" }) })).status, 403);
  // alg confusion: unsigned token
  const none = `${b64u(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64u(JSON.stringify({ iss: TEAM, aud: [AUD], exp: 9999999999 }))}.`;
  assert.equal((await rpc("tools/list", {}, { jwt: none })).status, 403);
  // no GitHub call may have happened
  assert.equal(calls.length, 0);
  // optional email pin
  const res = await worker.fetch(
    new Request("https://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-access-jwt-assertion": await makeJwt() },
      body: "{}",
    }),
    { ...env, ALLOWED_EMAIL: "someone-else@example.com" } as any,
  );
  assert.equal(res.status, 403);
});

test("valid token works; unknown origin and non-POST are refused; missing config fails closed", async () => {
  const ok = await rpc("tools/list", {});
  assert.equal(ok.status, 200);
  const names = ((await ok.json()) as any).result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["branch_create", "branches_list", "file_get", "grep", "pr_create", "pr_get", "prs_list", "push_files", "repo_tree", "repos_list"]);
  assert.ok(!names.some((n: string) => /merge|delete|api|graphql|workflow/.test(n)));

  assert.equal((await rpc("tools/list", {}, { origin: "https://evil.example" })).status, 403);
  const get = await worker.fetch(new Request("https://x/mcp"), env as any);
  assert.equal(get.status, 405);
  const other = await worker.fetch(new Request("https://x/other", { method: "POST" }), env as any);
  assert.equal(other.status, 404);

  const noToken = await worker.fetch(
    new Request("https://x/mcp", { method: "POST", headers: { "cf-access-jwt-assertion": await makeJwt() }, body: "{}" }),
    { ...env, GITHUB_TOKEN: "" } as any,
  );
  assert.equal(noToken.status, 500);
});

// --- policy -----------------------------------------------------------------
test("branch and path policy", () => {
  assert.equal(validateWritableBranch("claude/fix-1", "claude/", "main"), "claude/fix-1");
  for (const bad of ["main", "claude/", "feature/x", "claude/../main", "claude/a..b", "claude/x.lock", "claude//x", "claude/.hidden"]) {
    assert.throws(() => validateWritableBranch(bad, "claude/", "main"), UserError, bad);
  }
  assert.equal(validateFilePath("src/app.ts"), "src/app.ts");
  for (const bad of [
    ".github/workflows/ci.yml", ".GitHub/x", ".github./x", ".git/config", "a/.git/hooks/x", "GIT~1/x",
    "docs/CODEOWNERS", "CODEOWNERS", ".gitmodules", "../x", "/abs", "a//b", "a/./b", "a\\b", "x/", ".circleci/config.yml", "Jenkinsfile",
  ]) {
    assert.throws(() => validateFilePath(bad), UserError, bad);
  }
});

// --- end-to-end write flow ----------------------------------------------------
test("push_files refuses protected targets before any GitHub call", async () => {
  for (const args of [
    { branch: "main", message: "m", files: [{ path: "a.txt", content: "x" }] },
    { branch: "claude/x", message: "m", files: [{ path: ".github/workflows/ci.yml", content: "x" }] },
    { branch: "claude/x", message: "m", files: [{ path: "a.txt", content: "x" }], deletions: ["A.TXT"] },
    { branch: "claude/x", message: "m" },
  ]) {
    const r = await call("push_files", args);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.ok(calls.every((c) => c.method === "GET"), "no write calls may happen");
  assert.ok(!calls.some((c) => c.url.includes("/git/")), "validation must fail before touching git data");
});

test("push_files happy path: one commit, fast-forward only, token only goes to api.github.com", async () => {
  github = (c) => {
    const p = c.url.replace("https://api.github.com/repos/me/repo", "");
    if (c.method === "GET" && p === "/git/ref/heads/claude/x") return { body: { object: { sha: "c0" } } };
    if (c.method === "GET" && p === "/git/commits/c0") return { body: { sha: "c0", tree: { sha: "t0" } } };
    if (c.method === "GET" && p.startsWith("/git/trees/t0")) {
      return { body: { truncated: false, tree: [{ path: "run.sh", mode: "100755", type: "blob", sha: "s1" }, { path: "old.txt", mode: "100644", type: "blob", sha: "s2" }] } };
    }
    if (c.method === "POST" && p === "/git/trees") return { body: { sha: "t1" } };
    if (c.method === "POST" && p === "/git/commits") return { body: { sha: "c1abcdef" } };
    if (c.method === "PATCH" && p === "/git/refs/heads/claude/x") return { body: {} };
    return { status: 404, body: { message: "unexpected " + c.method + " " + p } };
  };
  const r = await call("push_files", {
    branch: "claude/x",
    message: "update",
    files: [{ path: "run.sh", content: "#!/bin/sh\n" }, { path: "new.txt", content: "hi" }],
    deletions: ["old.txt"],
  });
  assert.equal(r.isError, false, r.text);
  const treeCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/trees"))!;
  assert.equal(treeCall.body.base_tree, "t0");
  const byPath = Object.fromEntries(treeCall.body.tree.map((e: any) => [e.path, e]));
  assert.equal(byPath["run.sh"].mode, "100755"); // exec bit preserved
  assert.equal(byPath["new.txt"].mode, "100644");
  assert.equal(byPath["old.txt"].sha, null);
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.body.force, false);
  assert.ok(calls.every((c) => c.url.startsWith("https://api.github.com/repos/me/repo")));
  assert.ok(calls.every((c) => c.auth === "Bearer ghp_test_token"));
});

test("pr_create always targets the default branch and never merges", async () => {
  github = (c) => (c.method === "POST" && c.url.endsWith("/pulls") ? { body: { number: 7, html_url: "https://github.com/me/repo/pull/7" } } : { status: 404, body: { message: "nf" } });
  const bad = await call("pr_create", { head: "main", title: "t" });
  assert.equal(bad.isError, true);
  const ok = await call("pr_create", { head: "claude/x", title: "t", body: "b", base: "evil" });
  assert.equal(ok.isError, false);
  const post = calls.find((c) => c.url.endsWith("/pulls"))!;
  assert.equal(post.body.base, "main");
  assert.equal(post.body.head, "claude/x");
  assert.ok(!calls.some((c) => c.url.includes("/merge")));
});

test("multi-repo: allowlist is enforced before any GitHub call", async () => {
  env.ALLOWED_REPOS = "me/a, me/b";
  delete env.ALLOWED_REPO;
  const listed: any = await (await rpc("tools/list", {})).json();
  const rt = listed.result.tools.find((t: any) => t.name === "repo_tree");
  assert.deepEqual(rt.inputSchema.required, ["repo"]);

  for (const repo of ["me/c", "evil/a", "me/..", "../x", "me/a/../b", "ME", "", undefined]) {
    const r = await call("repo_tree", repo === undefined ? {} : { repo });
    assert.equal(r.isError, true, String(repo));
  }
  assert.equal(calls.length, 0);

  // allowed, case-insensitive
  github = (c) => (c.url.includes("/git/ref/heads/main") ? { body: { object: { sha: "c0" } } } : c.url.includes("/git/commits/c0") ? { body: { sha: "c0", tree: { sha: "t0" } } } : { body: { truncated: false, tree: [] } });
  const ok = await call("repo_tree", { repo: "ME/B" });
  assert.equal(ok.isError, false, ok.text);
  assert.ok(calls.every((c) => c.url.toLowerCase().startsWith("https://api.github.com/repos/me/b")));
});

test('multi-repo: "*" allows any repo the token reaches, still rejects traversal', async () => {
  env.ALLOWED_REPOS = "*";
  github = () => ({ status: 404, body: { message: "Not Found" } });
  await call("repo_tree", { repo: "other/thing" });
  assert.ok(calls.length > 0 && calls.every((c) => c.url.startsWith("https://api.github.com/repos/other/thing")));
  calls = [];
  for (const repo of ["a/..", "../b", "a/b/c", "a b/c"]) assert.equal((await call("repo_tree", { repo })).isError, true, repo);
  assert.equal(calls.length, 0);
});

test("multi-repo: each repo's own default branch is the PR base", async () => {
  env.ALLOWED_REPOS = "me/a,me/b";
  defaultBranches["me/b"] = "master";
  github = (c) => (c.method === "POST" && c.url.endsWith("/pulls") ? { body: { number: 3, html_url: "https://github.com/me/b/pull/3" } } : { status: 404, body: { message: "nf" } });
  const r = await call("pr_create", { repo: "me/b", head: "claude/x", title: "t" });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls.find((c) => c.url.endsWith("/pulls"))!.body.base, "master");
  // a repo whose default branch is literally named like a working branch can never be written
  defaultBranches["me/a"] = "claude/trunk";
  const w = await call("push_files", { repo: "me/a", branch: "claude/trunk", message: "m", files: [{ path: "a.txt", content: "x" }] });
  assert.equal(w.isError, true);
});

test("repos_list shows only writable repos inside the allowlist", async () => {
  github = (c) =>
    c.url.startsWith("https://api.github.com/user/repos")
      ? { body: [
          { full_name: "me/repo", default_branch: "main", private: true, archived: false, permissions: { push: true } },
          { full_name: "me/readonly", default_branch: "main", private: false, archived: false, permissions: { push: false } },
          { full_name: "me/other", default_branch: "main", private: false, archived: false, permissions: { push: true } },
        ] }
      : { status: 404, body: { message: "nf" } };
  const r = await call("repos_list", {});
  assert.equal(r.isError, false);
  assert.deepEqual(JSON.parse(r.text).map((x: any) => x.repo), ["me/repo"]); // legacy ALLOWED_REPO=me/repo
  env.ALLOWED_REPOS = "*";
  const all = JSON.parse((await call("repos_list", {})).text).map((x: any) => x.repo);
  assert.deepEqual(all, ["me/repo", "me/other"]); // read-only repos never listed
});

test("GitHub errors never leak the token, and redirects are refused", async () => {
  github = () => ({ status: 403, body: { message: "nope ghp_test_token nope" } });
  const r = await call("repo_tree", {});
  assert.equal(r.isError, true);
  assert.ok(!r.text.includes("ghp_test_token"));
  github = () => ({ status: 302, body: {} });
  const r2 = await call("repo_tree", {});
  assert.equal(r2.isError, true);
  assert.match(r2.text, /redirect/);
});
