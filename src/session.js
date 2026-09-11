// In-memory per-chat draft state. One draft at a time per chat.

const drafts = new Map();

const STEP = {
  IDLE: "idle",
  TITLE: "title",
  BODY: "body",
  REPO: "repo",
};

function getDraft(chatId) {
  return drafts.get(chatId);
}

function startDraft(chatId) {
  const draft = { step: STEP.TITLE, title: "", text: [], images: [] };
  drafts.set(chatId, draft);
  return draft;
}

function clearDraft(chatId) {
  drafts.delete(chatId);
}

export { getDraft, startDraft, clearDraft, STEP };
