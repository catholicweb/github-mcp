# github-mcp-secure

A deliberately small GitHub MCP server for Claude, running on Cloudflare Workers.
It lets Claude **propose** changes to **one repository** and nothing else.

| Claude can | Claude cannot |
|---|---|
| Read files / list the tree of the one allowed repo | Touch any other repo |
| Create branches named `claude/*` | Write to `main` or any non-`claude/*` branch |
| Commit to `claude/*` branches (fast-forward only, never force) | Merge, close, delete branches, or approve PRs |
| Open PRs into `main` | Edit `.github/`, CODEOWNERS, CI configs, `.git*` files |
| Read PRs | Call arbitrary GitHub API endpoints (no `gh_api`/GraphQL escape hatch) |

A human (you) reviews and merges every PR on GitHub.

## Security layers (outermost first)

1. **Cloudflare Access (Managed OAuth)** in front of the hostname. Only your email gets in; access tokens last 15 minutes; the grant lasts 7 days; only Claude's callback URLs may register.
2. **The Worker re-verifies the Access JWT itself** (RS256 signature against your team's keys, issuer, audience, expiry; optional email pin). `workers.dev` and preview URLs are disabled, so there is no side door.
3. **Hard-coded scope**: repo, base branch and branch prefix come from config, never from tool arguments.
4. **Path policy**: CI/workflow/governance files are refused (list in `src/validate.ts`).
5. **GitHub fine-grained token** limited to one repo and three permissions.
6. **GitHub ruleset on `main`** requiring a reviewed PR. This is the control that still holds if everything above has a bug.
7. **Audit log** of every tool call (who, which tool, ok/fail, duration; never file contents or tokens).

## What this does NOT protect you from (read this)

- **Prompt injection.** Claude reads repo content. A malicious string in a file or issue could try to steer it. Everything it can do ends up in a PR, so **read the diff of every PR yourself** before merging, including build scripts, `package.json` scripts, Makefiles and dependency changes. These can run code in CI or on your machine and are not blocked by the path policy.
- **A compromised GitHub token** can do what the token can: write `claude/*`-style branches (and any branch, since GitHub tokens cannot be restricted by branch name) in that one repo. The `main` ruleset limits the damage. Keep the token expiring and rotate it.
- **Your own Cloudflare/GitHub/Claude account security.** Use hardware-key or app-based MFA on all three.
- No rate limiting is built in. Add a Cloudflare rate-limiting rule on the hostname if you want one.

## Setup (about 20 minutes)

Prereqs: Node 22+, a domain whose DNS is on your Cloudflare account, Zero Trust enabled (free plan is fine) with a login method configured (prefer one that enforces MFA, e.g. Google or GitHub, over email one-time PIN).

### 1. GitHub token (fine-grained)

GitHub -> Settings -> Developer settings -> Fine-grained tokens -> Generate:

- **Resource owner:** you / your org
- **Repository access:** *Only select repositories* -> the one repo
- **Permissions:** Contents: **Read and write**, Pull requests: **Read and write**, Metadata: Read-only. **Nothing else.** (Do not grant Actions, Workflows or Administration.)
- **Expiration:** 30-90 days. Put a reminder in your calendar.

Keep it in your clipboard / password manager. Never paste it into a chat.

### 2. Protect `main` on GitHub

Repo -> Settings -> Rules -> Rulesets -> New branch ruleset, target `main`:

- Require a pull request before merging (at least 1 approval if you have a second account/reviewer; otherwise at least the PR requirement itself)
- Block force pushes and deletions
- Do not add bypass actors (and apply it to admins)
- Optional: require status checks you trust

### 3. Create the Access application

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...      # custom token: Account > Access: Apps and Policies > Edit
export MCP_HOST=github-mcp.example.com
export ALLOWED_EMAIL=you@example.com
./scripts/create-access-app.sh
```

It prints `ACCESS_AUD`. Revoke the API token afterwards.

### 4. Configure and deploy

Edit `wrangler.jsonc`:

- `routes[0].pattern` -> your hostname (same as `MCP_HOST`)
- `ACCESS_TEAM_DOMAIN` -> `https://<your-team>.cloudflareaccess.com` (Zero Trust -> Settings)
- `ACCESS_AUD` -> value from step 3
- `ALLOWED_REPO` -> `owner/repo`
- optional: uncomment `ALLOWED_EMAIL` (only if your Access JWTs carry an email claim; test it)

Then:

```bash
npm install
npm run typecheck
npm test
npx wrangler login
npx wrangler secret put GITHUB_TOKEN     # paste the token at the prompt
npm run deploy
```

Until the placeholders are replaced and the secret is set, the Worker returns HTTP 500 for everything (fails closed).

### 5. Verify before connecting

```bash
curl -si -X POST https://github-mcp.example.com/mcp -H 'content-type: application/json' -d '{}' | head -5
```

You should see **401** with a `www-authenticate` header (that's Access stopping you). If you get 200, 404 from the Worker, or 403 error code 1010, something is off; fix it before continuing. Also confirm `https://github-mcp-secure.<your-subdomain>.workers.dev` does **not** respond.

### 6. Connect Claude

Claude (web) -> Settings -> Connectors -> Add custom connector -> URL `https://github-mcp.example.com/mcp` -> Connect, then sign in through Cloudflare Access as the allowed email.

Afterwards, in the connector's tool permissions, set the write tools (`branch_create`, `push_files`, `pr_create`) to **require approval** rather than always-allow. The connector then works from the phone app too.

## Day-to-day

- Review and merge PRs on GitHub (the mobile app is fine).
- Enable "Automatically delete head branches" in repo settings, since this server cannot delete branches.
- Logs: `npm run tail`.
- Rotate token: `npx wrangler secret put GITHUB_TOKEN`.
- Cut off Claude immediately: Zero Trust -> Access -> Applications -> github-mcp-secure -> revoke existing tokens (or delete the app).

## Tools

`repo_tree`, `file_get`, `branches_list`, `branch_create`, `push_files`, `pr_create`, `prs_list`, `pr_get`.

## Tuning the restrictions

All in `src/validate.ts` (blocked directories/file names) and `wrangler.jsonc` (`BRANCH_PREFIX`, `DEFAULT_BRANCH`). If you want to widen anything, do it consciously and re-run `npm test`.
