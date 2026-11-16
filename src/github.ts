import { UserError, validateRepoName } from "./validate.ts";

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
  private base: string | null;
  private token: string;

  /** repo = owner/name for repo-scoped calls; omit for account-level calls (repos_list). */
  constructor(token: string, repo?: string) {
    this.token = token;
    this.base = repo === undefined ? null : `/repos/${validateRepoName(repo)}`;
  }

  async defaultBranch(): Promise<string> {
    const r = await this.request<{ default_branch: string }>("GET", "");
    return r.default_branch;
  }

  async listWritableRepos(): Promise<{ full_name: string; default_branch: string; private: boolean; archived: boolean }[]> {
    const list = await this.request<
      { full_name: string; default_branch: string; private: boolean; archived: boolean; permissions?: { push?: boolean } }[]
    >("GET", "/user/repos?per_page=100&sort=updated", undefined, "application/vnd.github+json", true);
    return list.filter((r) => r.permissions?.push === true);
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    accept = "application/vnd.github+json",
    root = false,
  ): Promise<T> {
    if (!root && this.base === null) throw new Error("repo-scoped request without a repo");
    const res = await fetch(`${API}${root ? "" : this.base}${path}`, {
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
