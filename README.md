# github-pr-review-mcp

A custom **Model Context Protocol** server that gives AI clients (Claude Code, Cursor, etc.) read/write access to GitHub PRs and commits, scoped for code review workflows.

Connects via **stdio**. Works with any GitHub repo — set defaults via env vars or pass `owner`/`repo` per call.

## Tools

**Read**
- `list_prs(state, per_page)` — list PRs.
- `get_pr(number)` — title, body, status, diff stats, mergeable.
- `get_pr_diff(number)` — raw unified diff for review.
- `list_pr_comments(number)` — top-level + inline review comments.
- `list_commits(sha?, since?, per_page)` — branch commit history.
- `get_commit(sha)` — message, stats, file patches.

**Write**
- `add_pr_comment(number, body)` — top-level comment.
- `add_pr_review_comment(number, path, line, body, side?)` — inline diff comment.

All tools accept optional `owner` and `repo` to override the env defaults.

## Setup

1. Copy `.env.example` → `.env`. Set `GITHUB_TOKEN` (PAT, scope: `repo`). Optionally set `GITHUB_OWNER` / `GITHUB_REPO` as defaults so you can omit them per-call.
2. `npm install`
3. Smoke test:
   ```
   npm run dev
   ```
   You should see `[github-pr-review] connected. default=...` on stderr. Ctrl+C to exit.

## Connect to Claude Code

Easiest — use the CLI from inside your cloned folder:

```bash
claude mcp add github-pr-review --scope user -- npx -y tsx "$(pwd)/src/server.ts"
```

Or add manually to `~/.claude.json` (user-scope) or a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "github-pr-review": {
      "command": "npx",
      "args": ["-y", "tsx", "/absolute/path/to/mcp-github-pr-review/src/server.ts"]
    }
  }
}
```

The server reads `GITHUB_TOKEN` / `GITHUB_OWNER` / `GITHUB_REPO` from a `.env` file next to `server.ts`, so you don't need to put them in the MCP config. (You can override with the config's `env` block if preferred.)

Restart Claude Code. Run `/mcp`. You should see `github-pr-review · ✓ connected · 8 tools`.

## Try it

```
> list the open PRs
> get the diff of PR 12 and flag anything risky
> get_pr in owner=facebook repo=react number=12345
```

