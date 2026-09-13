import { Octokit } from "@octokit/rest";
import { config } from "./config.js";

const octokit = new Octokit({ auth: config.githubToken });

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

async function listRepos() {
  const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
    per_page: 100,
    affiliation: "owner,collaborator",
  });
  return repos.map((r) => r.full_name).sort();
}

export { uploadAttachment, createIssue, addIssueComment, listRepos, splitRepo };
