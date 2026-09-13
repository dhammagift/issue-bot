import "dotenv/config";

function parseList(value) {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  githubToken: process.env.GITHUB_TOKEN,
  repos: parseList(process.env.GITHUB_REPOS),
  allowedUserIds: parseList(process.env.ALLOWED_USER_IDS).map(Number),
  groqApiKey: process.env.GROQ_API_KEY,
  // Where photos, videos and files from issues are stored (see github.js uploadAttachment).
  mediaRepo: process.env.MEDIA_REPO || "dhammagift/issue-media",
};

if (!config.telegramToken) {
  throw new Error("TELEGRAM_BOT_TOKEN is not set");
}
if (!config.githubToken) {
  throw new Error("GITHUB_TOKEN is not set");
}
