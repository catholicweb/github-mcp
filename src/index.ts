import { verifyAccessJwt, normalizeTeamDomain } from "./access.ts";
import { GitHub } from "./github.ts";
import { tools, type Config } from "./tools.ts";
import { UserError, asObject } from "./validate.ts";

export interface Env {
  GITHUB_TOKEN: string; // secret
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_REPO: string;
  DEFAULT_BRANCH?: string;
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

function loadConfig(env: Env): Config {
  const repo = env.ALLOWED_REPO;
  const prefix = env.BRANCH_PREFIX || "claude/";
  if (!repo || repo === "OWNER/REPO") throw new Error("ALLOWED_REPO not configured");
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret not set");
  if (!env.ACCESS_AUD || env.ACCESS_AUD.startsWith("TODO")) throw new Error("ACCESS_AUD not configured");
  normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN ?? ""); // throws if invalid
  if (!/^[A-Za-z0-9._-]+\/$/.test(prefix)) throw new Error("BRANCH_PREFIX must look like 'claude/'");
  return { repo, defaultBranch: env.DEFAULT_BRANCH || "main", prefix };
}

async function handleRpc(msg: Rpc, env: Env, cfg: Config, who: string): Promise<unknown | null> {
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
          instructions: `Restricted GitHub access to ${cfg.repo}. You can read files, create branches starting with "${cfg.prefix}", commit to them, and open pull requests into ${cfg.defaultBranch}. You cannot merge or change CI/workflow files; a human reviews every PR. Token-efficient workflow: find code with grep, read only what you need with file_get (start_line/end_line, or paths for several files), then change files with ONE push_files call using edits (patches), create_branch and pr; its result lists what changed, so no read-back is needed.`,
        },
      };
    }
    case "ping":
      return isNotification ? null : { jsonrpc: "2.0", id: msg.id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) },
      };
    case "tools/call": {
      const p = asObject(msg.params ?? {}, "params");
      const tool = tools.find((t) => t.name === p.name);
      if (!tool) return rpcError(msg.id, -32602, "Unknown tool");
      const started = Date.now();
      let ok = true;
      let text: string;
      try {
        const args = p.arguments === undefined ? {} : asObject(p.arguments, "arguments");
        text = await tool.run(new GitHub(env.GITHUB_TOKEN, cfg.repo), cfg, args);
      } catch (e) {
        ok = false;
        if (e instanceof UserError) text = e.message;
        else {
          console.error(JSON.stringify({ evt: "tool_error", tool: tool.name, err: String(e) }));
          text = "Internal error (details logged server-side).";
        }
      }
      // Audit log: who, what, outcome. Never log file contents or tokens.
      console.log(JSON.stringify({ evt: "tool_call", tool: tool.name, who, ok, ms: Date.now() - started }));
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
    let cfg: Config;
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
