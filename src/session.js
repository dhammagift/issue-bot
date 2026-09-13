// In-memory per-chat draft state. One draft at a time per chat.
import fs from "node:fs";

// The chosen repos are the default for every new issue until changed, so they are kept on disk:
// a bot restart must not silently bring the repo picker back.
const REPO_STATE_FILE = new URL("../data/repos.json", import.meta.url);

function loadRepoSelection() {
  try {
    const saved = JSON.parse(fs.readFileSync(REPO_STATE_FILE, "utf8"));
    return new Map(Object.entries(saved).map(([chatId, repos]) => [Number(chatId), repos]));
  } catch {
    return new Map();
  }
}

const drafts = new Map();
const lastRepoSelection = loadRepoSelection(); // chatId -> array of repo names, remembered across drafts
const lastIssueByUser = new Map(); // userId -> { repo, number, url }, last issue created via inline mode

const STEP = {
  REPO: "repo",
  BODY: "body",
};

function getDraft(chatId) {
  return drafts.get(chatId);
}

function startDraft(chatId) {
  const remembered = lastRepoSelection.get(chatId) || [];
  const draft = {
    step: STEP.REPO,
    title: "",
    text: [],
    files: [], // { buffer, filename, kind: "image" | "video" | "file" }
    selectedRepos: new Set(remembered),
  };
  drafts.set(chatId, draft);
  return draft;
}

function clearDraft(chatId) {
  drafts.delete(chatId);
}

function rememberRepoSelection(chatId, repos) {
  lastRepoSelection.set(chatId, [...repos]);
  try {
    fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
    fs.writeFileSync(REPO_STATE_FILE, JSON.stringify(Object.fromEntries(lastRepoSelection)));
  } catch (err) {
    console.error("Could not save the repo selection:", err.message);
  }
}

function getRememberedRepos(chatId) {
  return lastRepoSelection.get(chatId) || [];
}

function setLastIssue(userId, issue) {
  lastIssueByUser.set(userId, issue);
}

function getLastIssue(userId) {
  return lastIssueByUser.get(userId);
}

export {
  getDraft,
  startDraft,
  clearDraft,
  rememberRepoSelection,
  getRememberedRepos,
  setLastIssue,
  getLastIssue,
  STEP,
};
