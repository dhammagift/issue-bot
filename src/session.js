// In-memory per-chat draft state. One draft at a time per chat.

const drafts = new Map();
const lastRepoSelection = new Map(); // chatId -> array of repo names, remembered across drafts
const lastIssueByUser = new Map(); // userId -> { repo, number, url }, last issue created via inline mode

const STEP = {
  REPO: "repo",
  TITLE: "title",
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
    images: [],
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
  setLastIssue,
  getLastIssue,
  STEP,
};
