import { verifyAccessJwt, normalizeTeamDomain } from "./access.ts";
import { GitHub } from "./github.ts";
import { tools, reposListTool, type Config, type ServerCfg } from "./tools.ts";
import { UserError, asObject, validateRepoName } from "./validate.ts";

export interface Env {
  GITHUB_TOKEN: string; // secret
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Comma-separated owner/name list, or "*" for every repo the token can write to. */
  ALLOWED_REPOS?: string;
  /** Legacy single-repo setting (still honoured if ALLOWED_REPOS is unset). */
  ALLOWED_REPO?: string;
  BRANCH_PREFIX?: string;
  ALLOWED_EMAIL?: string;
}

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 1_500_000;
const ALLOWED_ORIGINS = new Set(["https://claude.ai", "https://claude.com"]);

const SECURITY_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function reply(status: number, body?: unknown, extra: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, ...extra },
  });
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };

function rpcError(id: Rpc["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function loadConfig(env: Env): ServerCfg {
  const raw = (env.ALLOWED_REPOS ?? env.ALLOWED_REPO ?? "").trim();
  const prefix = env.BRANCH_PREFIX || "claude/";
  if (!raw || raw.includes("OWNER/REPO")) throw new Error("ALLOWED_REPOS not configured");
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret not set");
  if (!env.ACCESS_AUD || env.ACCESS_AUD.startsWith("TODO")) throw new Error("ACCESS_AUD not configured");
  normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN ?? ""); // throws if invalid
  if (!/^[A-Za-z0-9._-]+\/$/.test(prefix)) throw new Error("BRANCH_PREFIX must look like 'claude/'");
  const repos: string[] | "*" =
    raw === "*" ? "*" : raw.split(",").map((r) => validateRepoName(r.trim(), "ALLOWED_REPOS entry"));
  return { repos, prefix };
}

/** Decide which repo a tool call targets, enforcing the allowlist. */
function resolveRepo(arg: unknown, cfg: ServerCfg): string {
  let repo: string;
  if (arg === undefined || arg === null) {
    if (cfg.repos !== "*" && cfg.repos.length === 1) repo = cfg.repos[0]!;
    else throw new UserError("repo: required (owner/name). Use repos_list to see which repositories are available.");
  } else {
    repo = validateRepoName(arg);
  }
  if (cfg.repos !== "*" && !cfg.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) {
    throw new UserError(`repo: "${repo}" is not in this server's allowlist`);
  }
  return repo;
}

/** Advertise the `repo` argument on every repo-scoped tool. */
function withRepoProp(schema: Record<string, unknown>, cfg: ServerCfg): Record<string, unknown> {
  const single = cfg.repos !== "*" && cfg.repos.length === 1;
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const req = ((schema.required as string[] | undefined) ?? []).slice();
  if (!single) req.unshift("repo");
  return {
    ...schema,
    properties: {
      repo: {
        type: "string",
        description: single ? `owner/name; defaults to ${(cfg.repos as string[])[0]}` : "Repository as owner/name (see repos_list).",
      },
      ...props,
    },
    ...(req.length ? { required: req } : {}),
  };
}

async function handleRpc(msg: Rpc, env: Env, cfg: ServerCfg, who: string): Promise<unknown | null> {
  if (msg === null || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "Invalid Request");
  }
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const requested = asObject(msg.params ?? {}, "params").protocolVersion;
      const version = typeof requested === "string" && SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "github-mcp-secure", version: "1.0.0" },
          instructions: `Restricted GitHub access to ${cfg.repos === "*" ? "the repositories the token can write to" : cfg.repos.join(", ")} (call repos_list). You can read files, create branches starting with "${cfg.prefix}", commit to them, and open pull requests into ${cfg.defaultBranch}. You cannot merge or change CI/workflow files; a human reviews every PR. Token-efficient workflow: for a small, targeted change, find code with grep (narrow path_prefix/glob; it scans at most 40 files per call and says PARTIAL when it did not cover everything, continue with offset), read only what you need with file_get (start_line/end_line, or paths for several files), then change files with ONE push_files call using edits (patches), create_branch and pr; its result lists what changed, so no read-back is needed. For broad exploration, multi-file changes or anything that needs running tests, clone the repo in your sandbox if it can reach github.com (read-only is fine) and still deliver the change through push_files. Do not split one change across several commits: the PR opens with the first. Fix a PR title/body with pr_update, and check CI with pr_get (checks).`,
        },
      };
    }
    case "ping":
      return isNotification ? null : { jsonrpc: "2.0", id: msg.id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            { name: reposListTool.name, description: reposListTool.description, inputSchema: reposListTool.inputSchema, annotations: reposListTool.annotations },
            ...tools.map(({ name, description, inputSchema, annotations }) => ({
              name,
              description,
              inputSchema: withRepoProp(inputSchema, cfg),
              annotations,
            })),
          ],
        },
      };
    case "tools/call": {
      const p = asObject(msg.params ?? {}, "params");
      const isList = p.name === reposListTool.name;
      const tool = isList ? undefined : tools.find((t) => t.name === p.name);
      if (!isList && !tool) return rpcError(msg.id, -32602, "Unknown tool");
      const toolName = isList ? reposListTool.name : tool!.name;
      const started = Date.now();
      let ok = true;
      let text: string;
      let repoForLog = "-";
      try {
        const args = p.arguments === undefined ? {} : asObject(p.arguments, "arguments");
        if (isList) {
          text = await reposListTool.run(new GitHub(env.GITHUB_TOKEN), cfg);
        } else {
          const repo = resolveRepo(args.repo, cfg);
          repoForLog = repo;
          const gh = new GitHub(env.GITHUB_TOKEN, repo);
          const repoCfg: Config = { repo, defaultBranch: await gh.defaultBranch(), prefix: cfg.prefix };
          text = await tool!.run(gh, repoCfg, args);
        }
      } catch (e) {
        ok = false;
        if (e instanceof UserError) text = e.message;
        else {
          console.error(JSON.stringify({ evt: "tool_error", tool: toolName, err: String(e) }));
          text = "Internal error (details logged server-side).";
        }
      }
      // Audit log: who, what, outcome. Never log file contents or tokens.
      console.log(JSON.stringify({ evt: "tool_call", tool: toolName, repo: repoForLog, who, ok, ms: Date.now() - started }));
      return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], ...(ok ? {} : { isError: true }) } };
    }
    default:
      if (msg.method.startsWith("notifications/") || isNotification) return null;
      return rpcError(msg.id, -32601, "Method not found");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") return reply(404, { error: "not found" });
    if (request.method !== "POST") return reply(405, { error: "method not allowed" }, { allow: "POST" });

    // 1. Config must be complete, otherwise refuse everything.
    let cfg: ServerCfg;
    try {
      cfg = loadConfig(env);
    } catch (e) {
      console.error(JSON.stringify({ evt: "misconfigured", err: String(e) }));
      return reply(500, { error: "server misconfigured" });
    }

    // 2. Browser-origin requests are never legitimate here (Claude calls server-to-server).
    const origin = request.headers.get("origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) return reply(403, { error: "forbidden" });

    // 3. Verify the Cloudflare Access JWT (defense in depth behind Access itself).
    const jwt = request.headers.get("cf-access-jwt-assertion");
    let who: string;
    try {
      if (!jwt) throw new Error("missing jwt");
      const claims = await verifyAccessJwt(jwt, {
        teamDomain: env.ACCESS_TEAM_DOMAIN,
        aud: env.ACCESS_AUD,
        allowedEmail: env.ALLOWED_EMAIL || undefined,
      });
      who = claims.email ?? claims.sub ?? "unknown";
    } catch (e) {
      console.warn(JSON.stringify({ evt: "auth_denied", reason: String(e) }));
      return reply(403, { error: "forbidden" });
    }

    // 4. Parse body with size limit.
    if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
      return reply(415, { error: "content-type must be application/json" });
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return reply(413, { error: "body too large" });
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return reply(413, { error: "body too large" });
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return reply(400, rpcError(null, -32700, "Parse error"));
    }

    // 5. Dispatch (single message or batch).
    if (Array.isArray(payload)) {
      if (payload.length === 0 || payload.length > 20) return reply(400, rpcError(null, -32600, "Invalid batch"));
      const out: unknown[] = [];
      for (const m of payload) {
        const r = await handleRpc(m as Rpc, env, cfg, who);
        if (r !== null) out.push(r);
      }
      return out.length ? reply(200, out) : reply(202);
    }
    const r = await handleRpc(payload as Rpc, env, cfg, who);
    return r === null ? reply(202) : reply(200, r);
  },
} satisfies ExportedHandler<Env>;
