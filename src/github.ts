import { UserError } from "./validate.ts";

const API = "https://api.github.com";

export class GitHubError extends UserError {
  status: number;
  constructor(status: number, message: string) {
    super(`GitHub API ${status}: ${message}`);
    this.status = status;
  }
}

/** The named branch does not exist (callers may create it). */
export class BranchMissing extends UserError {}

interface Ref {
  object: { sha: string };
}
interface CommitObj {
  sha: string;
  tree: { sha: string };
}
export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

/** Encode a slash-separated path segment by segment (keeps the slashes). */
export function encPath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

/**
 * GitHub client hard-bound to ONE repository. Every URL is built here, always
 * against https://api.github.com, and redirects are never followed, so the
 * token cannot be sent anywhere else.
 */
export class GitHub {
  private base: string;
  private token: string;

  constructor(token: string, repo: string) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("ALLOWED_REPO must be owner/name");
    this.token = token;
    this.base = `/repos/${repo}`;
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    accept = "application/vnd.github+json",
  ): Promise<T> {
    const res = await fetch(`${API}${this.base}${path}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "github-mcp-secure",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status >= 300 && res.status < 400) throw new GitHubError(res.status, "unexpected redirect (refused)");
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = (await res.json()) as { message?: string };
        if (j.message) msg = j.message;
      } catch {
        /* ignore */
      }
      if (res.status === 401) msg = "token rejected (expired or revoked?)";
      msg = msg.split(this.token).join("[redacted]");
      throw new GitHubError(res.status, msg.slice(0, 500));
    }
    if (accept.includes("diff") || accept.includes("raw")) return (await res.text()) as T;
    return (await res.json()) as T;
  }

  async branchHead(branch: string): Promise<{ commitSha: string; treeSha: string }> {
    let ref: Ref;
    try {
      ref = await this.request<Ref>("GET", `/git/ref/heads/${encPath(branch)}`);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) throw new BranchMissing(`branch "${branch}" does not exist`);
      throw e;
    }
    const commit = await this.request<CommitObj>("GET", `/git/commits/${ref.object.sha}`);
    return { commitSha: commit.sha, treeSha: commit.tree.sha };
  }

  async getTree(treeSha: string): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
    return this.request("GET", `/git/trees/${treeSha}?recursive=1`);
  }
}

export function bytesToUtf8(b64: string): string | null {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null; // binary
  }
}
