import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";
import { z } from "zod";

const TOKEN = process.env.GITHUB_TOKEN;
const DEFAULT_OWNER = process.env.GITHUB_OWNER;
const DEFAULT_REPO = process.env.GITHUB_REPO;

if (!TOKEN) {
  console.error("Missing GITHUB_TOKEN in env");
  process.exit(1);
}

const octokit = new Octokit({ auth: TOKEN });

// ---- Allowlists -----------------------------------------------------------
// Even though the token may grant access to many repos, we constrain what
// this server will touch on the model's behalf. `*` = wildcard.
function parseAllowlist(raw: string | undefined, fallback: string[]): Set<string> {
  const source = raw ?? fallback.join(",");
  return new Set(
    source
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

const fallbackReadList =
  DEFAULT_OWNER && DEFAULT_REPO ? [`${DEFAULT_OWNER}/${DEFAULT_REPO}`] : ["*"];

const READ_ALLOW = parseAllowlist(process.env.GITHUB_ALLOWED_REPOS, fallbackReadList);
const WRITE_ALLOW = parseAllowlist(
  process.env.GITHUB_WRITE_ALLOWED_REPOS,
  [...READ_ALLOW],
);

function isAllowed(owner: string, repo: string, set: Set<string>): boolean {
  if (set.has("*")) return true;
  return set.has(`${owner}/${repo}`.toLowerCase());
}

function resolveRepo(
  args: { owner?: string; repo?: string },
  mode: "read" | "write",
): { owner: string; repo: string } {
  const owner = args.owner ?? DEFAULT_OWNER;
  const repo = args.repo ?? DEFAULT_REPO;
  if (!owner || !repo) {
    throw new Error(
      "owner and repo required (set GITHUB_OWNER/GITHUB_REPO defaults, or pass owner/repo args)",
    );
  }
  const set = mode === "write" ? WRITE_ALLOW : READ_ALLOW;
  if (!isAllowed(owner, repo, set)) {
    const envName = mode === "write" ? "GITHUB_WRITE_ALLOWED_REPOS" : "GITHUB_ALLOWED_REPOS";
    throw new Error(
      `repo ${owner}/${repo} not in ${envName} allowlist (mode=${mode})`,
    );
  }
  return { owner, repo };
}

const repoArgs = {
  owner: { type: "string", description: "Repo owner (org or user). Defaults to GITHUB_OWNER env." },
  repo: { type: "string", description: "Repo name. Defaults to GITHUB_REPO env." },
} as const;

// ---- Tool schemas ---------------------------------------------------------
const RepoArgs = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
});

const ListPrsArgs = RepoArgs.extend({
  state: z.enum(["open", "closed", "all"]).default("open"),
  per_page: z.number().int().min(1).max(50).default(20),
});

const GetPrArgs = RepoArgs.extend({
  number: z.number().int().positive(),
});

const GetPrDiffArgs = RepoArgs.extend({
  number: z.number().int().positive(),
});

const ListPrCommentsArgs = RepoArgs.extend({
  number: z.number().int().positive(),
});

const AddPrCommentArgs = RepoArgs.extend({
  number: z.number().int().positive(),
  body: z.string().min(1),
});

const AddPrReviewCommentArgs = RepoArgs.extend({
  number: z.number().int().positive(),
  body: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
});

const ListCommitsArgs = RepoArgs.extend({
  sha: z.string().optional(),
  since: z.string().optional(),
  per_page: z.number().int().min(1).max(50).default(20),
});

const GetCommitArgs = RepoArgs.extend({
  sha: z.string().min(1),
});

const ListMyReposArgs = z.object({
  visibility: z.enum(["all", "public", "private"]).default("all"),
  affiliation: z.string().default("owner,collaborator,organization_member"),
  sort: z.enum(["created", "updated", "pushed", "full_name"]).default("pushed"),
  per_page: z.number().int().min(1).max(100).default(30),
});

// ---- MCP server -----------------------------------------------------------
const server = new Server(
  { name: "github-pr-review", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// Advertise our tools to the client.
const defaultRepoNote =
  DEFAULT_OWNER && DEFAULT_REPO
    ? ` Defaults to ${DEFAULT_OWNER}/${DEFAULT_REPO} if owner/repo are omitted.`
    : "";

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_prs",
      description: `List pull requests in a GitHub repo. Returns number, title, state, author, branch, updated_at.${defaultRepoNote}`,
      inputSchema: {
        type: "object",
        properties: {
          ...repoArgs,
          state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
          per_page: { type: "number", default: 20 },
        },
      },
    },
    {
      name: "get_pr",
      description: `Get details for a single PR: title, body, status, files changed, additions, deletions, mergeable.${defaultRepoNote}`,
      inputSchema: {
        type: "object",
        properties: { ...repoArgs, number: { type: "number" } },
        required: ["number"],
      },
    },
    {
      name: "get_pr_diff",
      description: `Get the unified diff (patch text) of a PR for code review.${defaultRepoNote}`,
      inputSchema: {
        type: "object",
        properties: { ...repoArgs, number: { type: "number" } },
        required: ["number"],
      },
    },
    {
      name: "list_pr_comments",
      description: `List both top-level (issue) comments and inline review comments on a PR.${defaultRepoNote}`,
      inputSchema: {
        type: "object",
        properties: { ...repoArgs, number: { type: "number" } },
        required: ["number"],
      },
    },
    {
      name: "add_pr_comment",
      description: `Post a top-level (issue-style) comment on a PR.${defaultRepoNote}`,
      inputSchema: {
        type: "object",
        properties: { ...repoArgs, number: { type: "number" }, body: { type: "string" } },
        required: ["number", "body"],
      },
    },
    {
      name: "add_pr_review_comment",
      description: `Post an inline review comment on a specific line of a PR's diff. side='RIGHT' is the new version (most common); 'LEFT' is the old.${defaultRepoNote}`,
      inputSchema: {
        type: "object",
        properties: {
          ...repoArgs,
          number: { type: "number" },
          body: { type: "string" },
          path: { type: "string", description: "Relative file path within the repo." },
          line: { type: "number", description: "Line number in the file (1-indexed)." },
          side: { type: "string", enum: ["LEFT", "RIGHT"], default: "RIGHT" },
        },
        required: ["number", "body", "path", "line"],
      },
    },
    {
      name: "list_commits",
      description: `List commits on a branch (defaults to the repo's default branch). Optional 'since' is ISO-8601 (e.g. '2026-05-01T00:00:00Z').${defaultRepoNote}`,
      inputSchema: {
        type: "object",
        properties: {
          ...repoArgs,
          sha: { type: "string", description: "Branch name or commit SHA to start from." },
          since: { type: "string", description: "ISO-8601 timestamp lower bound." },
          per_page: { type: "number", default: 20 },
        },
      },
    },
    {
      name: "get_commit",
      description: `Get a single commit's metadata, message, and file patches.${defaultRepoNote}`,
      inputSchema: {
        type: "object",
        properties: { ...repoArgs, sha: { type: "string" } },
        required: ["sha"],
      },
    },
    {
      name: "list_my_repos",
      description:
        "List repos the authenticated user has access to (owned, collaborator, or via org membership). Use to discover what `owner/repo` values are valid before calling other tools.",
      inputSchema: {
        type: "object",
        properties: {
          visibility: {
            type: "string",
            enum: ["all", "public", "private"],
            default: "all",
          },
          affiliation: {
            type: "string",
            description:
              "Comma-separated subset of owner,collaborator,organization_member. Defaults to all three.",
            default: "owner,collaborator,organization_member",
          },
          sort: {
            type: "string",
            enum: ["created", "updated", "pushed", "full_name"],
            default: "pushed",
          },
          per_page: { type: "number", default: 30 },
        },
      },
    },
  ],
}));

// Run a tool when the client calls one.
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  try {
    if (name === "list_prs") {
      const args = ListPrsArgs.parse(rawArgs ?? {});
      const { owner, repo } = resolveRepo(args, "read");
      const { data } = await octokit.pulls.list({
        owner,
        repo,
        state: args.state,
        per_page: args.per_page,
      });
      const slim = data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        author: pr.user?.login,
        branch: pr.head.ref,
        base: pr.base.ref,
        updated_at: pr.updated_at,
        url: pr.html_url,
      }));
      return { content: [{ type: "text", text: JSON.stringify(slim, null, 2) }] };
    }

    if (name === "get_pr") {
      const args = GetPrArgs.parse(rawArgs);
      const { owner, repo } = resolveRepo(args, "read");
      const { data } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: args.number,
      });
      const slim = {
        number: data.number,
        title: data.title,
        body: data.body,
        state: data.state,
        author: data.user?.login,
        branch: data.head.ref,
        base: data.base.ref,
        mergeable: data.mergeable,
        additions: data.additions,
        deletions: data.deletions,
        changed_files: data.changed_files,
        url: data.html_url,
      };
      return { content: [{ type: "text", text: JSON.stringify(slim, null, 2) }] };
    }

    if (name === "get_pr_diff") {
      const args = GetPrDiffArgs.parse(rawArgs);
      const { owner, repo } = resolveRepo(args, "read");
      const res = await octokit.pulls.get({
        owner,
        repo,
        pull_number: args.number,
        mediaType: { format: "diff" },
      });
      // When format=diff, octokit returns the raw diff string in `data`.
      const diff = res.data as unknown as string;
      return { content: [{ type: "text", text: diff }] };
    }

    if (name === "list_pr_comments") {
      const args = ListPrCommentsArgs.parse(rawArgs);
      const { owner, repo } = resolveRepo(args, "read");
      const [issueComments, reviewComments] = await Promise.all([
        octokit.issues.listComments({ owner, repo, issue_number: args.number, per_page: 100 }),
        octokit.pulls.listReviewComments({ owner, repo, pull_number: args.number, per_page: 100 }),
      ]);
      const out = {
        top_level: issueComments.data.map((c) => ({
          id: c.id,
          author: c.user?.login,
          created_at: c.created_at,
          body: c.body,
        })),
        inline: reviewComments.data.map((c) => ({
          id: c.id,
          author: c.user?.login,
          path: c.path,
          line: c.line ?? c.original_line,
          side: c.side,
          created_at: c.created_at,
          body: c.body,
        })),
      };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }

    if (name === "add_pr_comment") {
      const args = AddPrCommentArgs.parse(rawArgs);
      const { owner, repo } = resolveRepo(args, "write");
      const { data } = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: args.number,
        body: args.body,
      });
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, id: data.id, url: data.html_url }, null, 2) },
        ],
      };
    }

    if (name === "add_pr_review_comment") {
      const args = AddPrReviewCommentArgs.parse(rawArgs);
      const { owner, repo } = resolveRepo(args, "write");
      // Use the PR head SHA so the comment anchors to the latest commit on the PR.
      const pr = await octokit.pulls.get({ owner, repo, pull_number: args.number });
      const { data } = await octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number: args.number,
        commit_id: pr.data.head.sha,
        body: args.body,
        path: args.path,
        line: args.line,
        side: args.side,
      });
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, id: data.id, url: data.html_url }, null, 2) },
        ],
      };
    }

    if (name === "list_commits") {
      const args = ListCommitsArgs.parse(rawArgs);
      const { owner, repo } = resolveRepo(args, "read");
      const { data } = await octokit.repos.listCommits({
        owner,
        repo,
        sha: args.sha,
        since: args.since,
        per_page: args.per_page,
      });
      const slim = data.map((c) => ({
        sha: c.sha,
        author: c.commit.author?.name,
        date: c.commit.author?.date,
        message: c.commit.message.split("\n")[0],
        url: c.html_url,
      }));
      return { content: [{ type: "text", text: JSON.stringify(slim, null, 2) }] };
    }

    if (name === "get_commit") {
      const args = GetCommitArgs.parse(rawArgs);
      const { owner, repo } = resolveRepo(args, "read");
      const { data } = await octokit.repos.getCommit({ owner, repo, ref: args.sha });
      const slim = {
        sha: data.sha,
        author: data.commit.author?.name,
        date: data.commit.author?.date,
        message: data.commit.message,
        stats: data.stats,
        files: data.files?.map((f) => ({
          path: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        })),
        url: data.html_url,
      };
      return { content: [{ type: "text", text: JSON.stringify(slim, null, 2) }] };
    }

    if (name === "list_my_repos") {
      const args = ListMyReposArgs.parse(rawArgs ?? {});
      const { data } = await octokit.repos.listForAuthenticatedUser({
        visibility: args.visibility,
        affiliation: args.affiliation,
        sort: args.sort,
        per_page: args.per_page,
      });
      const slim = data.map((r) => ({
        full_name: r.full_name,
        owner: r.owner.login,
        repo: r.name,
        private: r.private,
        default_branch: r.default_branch,
        pushed_at: r.pushed_at,
        url: r.html_url,
      }));
      return { content: [{ type: "text", text: JSON.stringify(slim, null, 2) }] };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `unknown tool: ${name}` }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `error: ${msg}` }] };
  }
});

// ---- Wire up stdio transport ---------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[github-pr-review] connected. default=${DEFAULT_OWNER ?? "(none)"}/${DEFAULT_REPO ?? "(none)"} read=[${[...READ_ALLOW].join(",")}] write=[${[...WRITE_ALLOW].join(",")}]`,
);
