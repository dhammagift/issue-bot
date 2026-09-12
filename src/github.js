import { Octokit } from "@octokit/rest";
import { config } from "./config.js";

const octokit = new Octokit({ auth: config.githubToken });

const IMAGE_DIR = "issue-images";

function splitRepo(fullName) {
  const [owner, repo] = fullName.split("/");
  return { owner, repo };
}

async function getDefaultBranch(owner, repo) {
  const { data } = await octokit.repos.get({ owner, repo });
  return data.default_branch;
}

// Uploads a single image to the repo (as a commit to the default branch)
// and returns a raw.githubusercontent.com URL usable in Markdown.
async function uploadImage(fullName, buffer, filename) {
  const { owner, repo } = splitRepo(fullName);
  const branch = await getDefaultBranch(owner, repo);
  const path = `${IMAGE_DIR}/${Date.now()}-${filename}`;

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch,
    message: `Add issue image ${filename}`,
    content: buffer.toString("base64"),
  });

  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
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

export { uploadImage, createIssue, addIssueComment, splitRepo };
