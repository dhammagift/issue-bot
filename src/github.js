import { Octokit } from "@octokit/rest";
import { config } from "./config.js";

// The server's connections to GitHub sometimes stall: a fresh TCP connect takes 11 s or never completes,
// the next one goes through in 0.1 s. Node's fetch gives up connecting after 10 s, so a single stall
// failed the whole "Done". Retrying only errors raised before the request was sent is safe for POSTs
// too (nothing reached GitHub, no duplicate issues); anything after that is thrown as before.
const RETRYABLE = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);
const ATTEMPTS = 4;

export async function fetchWithRetry(url, options) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      const code = err?.cause?.code || err?.code;
      if (attempt >= ATTEMPTS || !RETRYABLE.has(code)) throw err;
      console.warn(`GitHub ${code}, retry ${attempt}/${ATTEMPTS - 1}: ${url}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

const octokit = new Octokit({ auth: config.githubToken, request: { fetch: fetchWithRetry } });

function splitRepo(fullName) {
  const [owner, repo] = fullName.split("/");
  return { owner, repo };
}

async function getDefaultBranch(owner, repo) {
  const { data } = await octokit.repos.get({ owner, repo });
  return data.default_branch;
}

// Uploads one attachment (image, video, any file) as a commit to the media repo (MEDIA_REPO), into
// a folder named after the issue's repo. Attachments used to be committed into the issue's own repo
// (issue-images/), which bloated working repos that get pulled onto servers (owner). The public API
// can't create real issue attachments, so a commit to a separate repo is the substitute.
// Returns { raw, page }: raw renders inline for images, page is GitHub's file view (video player).
async function uploadAttachment(folder, buffer, filename) {
  const { owner, repo } = splitRepo(config.mediaRepo);
  const branch = await getDefaultBranch(owner, repo);
  const safeName = filename.replace(/[\/\\]/g, "_");
  const path = `${folder}/${Date.now()}-${safeName}`;

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch,
    message: `Add ${path}`,
    content: buffer.toString("base64"),
  });

  const urlPath = path.split("/").map(encodeURIComponent).join("/");
  return {
    raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${urlPath}`,
    page: `https://github.com/${owner}/${repo}/blob/${branch}/${urlPath}`,
  };
}

async function createIssue(fullName, { title, body }) {
  const { owner, repo } = splitRepo(fullName);
  const { data } = await octokit.issues.create({
    owner,
    repo,
    title,
    body,
  });
  return data;
}

async function addIssueComment(fullName, issueNumber, body) {
  const { owner, repo } = splitRepo(fullName);
  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return data;
}

// Repos the token can actually open issues in. A fine-grained token also lists repos it may only read,
// and GitHub has no read-only way to ask what it may write, so each repo gets POST /issues with an empty
// title: 422 (validation failed) = allowed, 403 = not. Nothing is ever created. Cached for an hour, so
// a repo newly granted to the token shows up without editing .env or restarting.
const REPO_CACHE_MS = 60 * 60 * 1000;
let repoCache = { at: 0, repos: [] };

async function listRepos() {
  if (repoCache.repos.length && Date.now() - repoCache.at < REPO_CACHE_MS) return repoCache.repos;
  const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
    per_page: 100,
    affiliation: "owner,collaborator",
  });
  const writable = await Promise.all(
    repos
      .filter((r) => !r.archived && r.has_issues)
      .map(async (r) => {
        try {
          await octokit.request("POST /repos/{owner}/{repo}/issues", { owner: r.owner.login, repo: r.name, title: "" });
        } catch (err) {
          return err.status === 422 ? r.full_name : null;
        }
        return null;
      })
  );
  repoCache = { at: Date.now(), repos: writable.filter(Boolean).sort() };
  return repoCache.repos;
}

export { uploadAttachment, createIssue, addIssueComment, listRepos, splitRepo };
