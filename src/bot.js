import { Bot, InlineKeyboard, InlineQueryResultBuilder, Keyboard } from "grammy";
import { config } from "./config.js";
import {
  getDraft,
  startDraft,
  clearDraft,
  rememberRepoSelection,
  getRememberedRepos,
  setLastIssue,
  getLastIssue,
  STEP,
} from "./session.js";
import { uploadAttachment, createIssue, addIssueComment, listRepos, splitRepo } from "./github.js";

const bot = new Bot(config.telegramToken);

if (config.repos.length === 0) {
  config.repos = await listRepos();
  console.log(`Auto-discovered ${config.repos.length} repos: ${config.repos.join(", ")}`);
  // Repos granted to (or taken from) the token later appear without a restart. A failed refresh keeps
  // the previous list.
  setInterval(async () => {
    try {
      const repos = await listRepos();
      if (repos.length && repos.join() !== config.repos.join()) {
        config.repos = repos;
        console.log(`Repo list refreshed: ${repos.join(", ")}`);
      }
    } catch (err) {
      console.warn(`Repo list refresh failed, keeping the old one: ${err.message}`);
    }
  }, 60 * 60 * 1000);
}
if (config.repos.length === 0) {
  throw new Error("No repos accessible with this GITHUB_TOKEN");
}

async function transcribeVoice(buffer, filename) {
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  form.append("model", "whisper-large-v3-turbo");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.groqApiKey}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Groq error ${res.status}`);
  return data.text.trim();
}

function isAllowed(ctx) {
  if (config.allowedUserIds.length === 0) return true;
  return config.allowedUserIds.includes(ctx.from?.id);
}

bot.use(async (ctx, next) => {
  if (!isAllowed(ctx)) {
    await ctx.reply("Access denied.");
    return;
  }
  await next();
});

const BTN_NEW = "🆕 New issue";
const BTN_DONE = "✅ Press when done";
const BTN_DONE_OLD = "✅ Done"; // still sent by keyboards clients show from before the rename
const BTN_STATUS = "📋 Status";
const BTN_CANCEL = "❌ Cancel";
const BTN_ISSUES = "📂 Open issues";
// "Set repo" replaced "New issue" on the keyboard (owner): an issue starts by itself from the first
// message, so choosing the repo is the only thing left to do up front. BTN_NEW stays handled for
// keyboards Telegram clients still show from before.
const BTN_REPO = "📁 Set repo";

const NO_REPO_HINT = `No repo chosen yet — tap "${BTN_REPO}".`;

const mainKeyboard = new Keyboard()
  .text(BTN_REPO).text(BTN_ISSUES).row()
  .text(BTN_DONE).text(BTN_STATUS).text(BTN_CANCEL)
  .resized();

function repoLinksKeyboard(suffix) {
  const keyboard = new InlineKeyboard();
  for (const repo of config.repos) {
    keyboard.url(repo, `https://github.com/${repo}${suffix}`).row();
  }
  return keyboard;
}

function issuesHandler(ctx) {
  return ctx.reply("Open a repo's issues:", { reply_markup: repoLinksKeyboard("/issues") });
}

// One tap on a repo picks it and closes the picker (owner: "Next" is only natural when picking
// several). "Pick several" switches to checkboxes + "Next ▶" for a shared issue.
function repoKeyboard(draft) {
  const keyboard = new InlineKeyboard();
  for (const repo of config.repos) {
    const mark = draft.selectedRepos.has(repo) ? "✅ " : "";
    keyboard.text(`${mark}${repo}`, `repo:${repo}`).row();
  }
  if (draft.multiPick) keyboard.text("Next ▶", "confirm-repos");
  else keyboard.text("Pick several…", "multi-repos");
  return keyboard;
}

function encodeIssueRef(repo, number) {
  return Buffer.from(`${repo}#${number}`).toString("base64url");
}

function decodeIssueRef(payload) {
  const [repo, numStr] = Buffer.from(payload, "base64url").toString().split("#");
  return { repo, number: Number(numStr) };
}

function startHandler(ctx) {
  const payload = ctx.match;
  if (payload) {
    const { repo, number } = decodeIssueRef(payload);
    const url = `https://github.com/${repo}/issues/${number}`;
    setLastIssue(ctx.from.id, { repo, number, url });
    return ctx.reply(`Send photos — I'll attach them to ${repo}#${number}:\n${url}`);
  }

  return ctx.reply(
    "Hi! I collect text, photos, videos and files into an issue draft and create it on GitHub.\n\n" +
      `${BTN_REPO} — choose the repo once, then just send messages\n${BTN_ISSUES} — quick links to repo issues\n` +
      `${BTN_DONE} — create the issue from the draft\n${BTN_STATUS} — show the current draft\n${BTN_CANCEL} — discard the draft`,
    { reply_markup: mainKeyboard }
  );
}

function cancelHandler(ctx) {
  clearDraft(ctx.chat.id);
  return ctx.reply("Draft discarded.");
}

function statusHandler(ctx) {
  const draft = getDraft(ctx.chat.id);
  const remembered = getRememberedRepos(ctx.chat.id);
  if (!draft) {
    return ctx.reply(
      remembered.length
        ? `No active draft. New issues go to: ${remembered.join(", ")} — just send a message.`
        : NO_REPO_HINT
    );
  }
  return ctx.reply(
    `Step: ${draft.step}\nRepos: ${[...draft.selectedRepos].join(", ") || "(none)"}\n` +
      `Title: ${draft.title || "(none)"}\nText: ${draft.text.length} message(s)\nAttachments: ${draft.files.length}`
  );
}

function bodyPrompt(draft) {
  return (
    `📁 Repo: ${[...draft.selectedRepos].join(", ")}\n` +
    "Send text, photos, videos, files or voice. The first line/sentence becomes the title.\n" +
    `When you're done — tap "${BTN_DONE}". Another repo — "${BTN_REPO}".`
  );
}

function changeRepoKeyboard() {
  return new InlineKeyboard().text(BTN_REPO, "change-repos");
}

function showRepoPicker(ctx, draft) {
  draft.step = STEP.REPO;
  draft.multiPick = draft.selectedRepos.size > 1;
  return ctx.reply(
    "Tap a repo — new issues keep going there until you change it. " +
      "For one issue in several repos — \"Pick several…\".",
    { reply_markup: repoKeyboard(draft) }
  );
}

// The repo is chosen once and kept: a new issue starts right in it, the picker only shows up
// when nothing is chosen yet or on "Repo" (owner: don't pick the repo before every ticket).
function newIssueHandler(ctx) {
  const draft = startDraft(ctx.chat.id);
  if (draft.selectedRepos.size === 0) return showRepoPicker(ctx, draft);
  draft.step = STEP.BODY;
  return ctx.reply(`🆕 New issue\n${bodyPrompt(draft)}`, { reply_markup: changeRepoKeyboard() });
}

function changeRepoHandler(ctx) {
  const draft = getDraft(ctx.chat.id) || startDraft(ctx.chat.id);
  return showRepoPicker(ctx, draft);
}

// A message with no draft starts a new issue in the chosen repo right away.
function draftForMessage(ctx) {
  const existing = getDraft(ctx.chat.id);
  if (existing) return { draft: existing, started: false };
  if (getRememberedRepos(ctx.chat.id).length === 0) return { draft: null, started: false };
  const draft = startDraft(ctx.chat.id);
  draft.step = STEP.BODY;
  return { draft, started: true };
}

function addedReply(draft, started, what) {
  const repos = [...draft.selectedRepos].join(", ");
  return `${started ? "🆕 New issue\n" : ""}${what} → ${repos}`;
}

function defaultTitle(repo) {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `${repo} issue ${stamp}`;
}

function doneInlineKeyboard() {
  return new InlineKeyboard().text(BTN_DONE, "inline-done");
}

async function doneHandler(ctx) {
  const draft = getDraft(ctx.chat.id);
  // No step check: the repo picker can still be open ("Set repo" pressed, "Next" never tapped) while
  // the draft already has text and attachments — Done used to answer "nothing to finish" (owner bug).
  if (!draft) return ctx.reply("Nothing to send yet — send a message to start an issue.");
  if (draft.selectedRepos.size === 0) return ctx.reply(NO_REPO_HINT);
  if (!draft.title && draft.text.length === 0 && draft.files.length === 0) {
    return ctx.reply("The draft is empty — send text, a photo, a video or a file first.");
  }
  draft.step = STEP.BODY;

  await ctx.reply(`Creating the issue in: ${[...draft.selectedRepos].join(", ")}…`);

  // Attachments are uploaded once to the media repo and linked from every issue of this draft.
  // On failure the draft is kept, so "Done" can simply be pressed again.
  const folder = [...draft.selectedRepos].map((r) => splitRepo(r).repo).join("+");
  const attachments = [];
  try {
    for (const f of draft.files) {
      attachments.push(attachmentMarkdown(f, await uploadAttachment(folder, f.buffer, f.filename)));
    }
  } catch (err) {
    console.error(err);
    return ctx.reply(`Could not upload the attachments, the draft is kept: ${err.message}`);
  }

  const results = [];
  const okRepos = [];
  for (const repo of draft.selectedRepos) {
    try {
      const bodyParts = [...draft.text, ...attachments];

      const title = draft.title || defaultTitle(repo);
      const issue = await createIssue(repo, {
        title,
        body: bodyParts.join("\n\n") || "(no description)",
      });
      results.push(`${repo}: ${issue.html_url}`);
      okRepos.push(repo);
    } catch (err) {
      console.error(err);
      results.push(`${repo}: error — ${err.message}`);
    }
  }

  clearDraft(ctx.chat.id);

  const keyboard = new InlineKeyboard();
  for (const repo of okRepos) {
    keyboard.url(`Issues: ${repo}`, `https://github.com/${repo}/issues`).row();
  }
  await ctx.reply(results.join("\n"), okRepos.length > 0 ? { reply_markup: keyboard } : undefined);
  // Separate message (owner): the link above stays a clean "here is your issue".
  await ctx.reply(
    `The next issue will be created in ${[...draft.selectedRepos].join(", ")} — just send a message.`,
    { reply_markup: changeRepoKeyboard() }
  );
}

bot.command("start", startHandler);
bot.command("cancel", cancelHandler);
bot.command("status", statusHandler);
bot.command("newissue", newIssueHandler);
bot.command("done", doneHandler);
bot.command("issues", issuesHandler);
bot.command("repo", changeRepoHandler);

bot.hears(BTN_NEW, newIssueHandler);
bot.hears(BTN_REPO, changeRepoHandler);
bot.hears([BTN_DONE, BTN_DONE_OLD], doneHandler);
bot.hears(BTN_STATUS, statusHandler);
bot.hears(BTN_CANCEL, cancelHandler);
bot.hears(BTN_ISSUES, issuesHandler);

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data === "inline-done") {
    await ctx.answerCallbackQuery();
    return doneHandler(ctx);
  }

  if (data === "change-repos") {
    await ctx.answerCallbackQuery();
    return changeRepoHandler(ctx);
  }

  const draft = getDraft(ctx.chat.id);
  // Any step: content may already have been added while the picker was open.
  if (!draft) {
    await ctx.answerCallbackQuery({ text: "Draft not found." });
    return;
  }

  if (data === "multi-repos") {
    draft.multiPick = true;
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: repoKeyboard(draft) });
    return;
  }

  if (data.startsWith("repo:") && !draft.multiPick) {
    draft.selectedRepos = new Set([data.slice("repo:".length)]);
    rememberRepoSelection(ctx.chat.id, draft.selectedRepos);
    draft.step = STEP.BODY;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(bodyPrompt(draft));
    return;
  }

  if (data.startsWith("repo:")) {
    const repo = data.slice("repo:".length);
    if (draft.selectedRepos.has(repo)) {
      draft.selectedRepos.delete(repo);
    } else {
      draft.selectedRepos.add(repo);
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: repoKeyboard(draft) });
    return;
  }

  if (data !== "confirm-repos") return;

  if (draft.selectedRepos.size === 0) {
    await ctx.answerCallbackQuery({ text: "Pick at least one repo." });
    return;
  }

  rememberRepoSelection(ctx.chat.id, draft.selectedRepos);
  draft.step = STEP.BODY;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(bodyPrompt(draft));
});

function handleTextInput(ctx, draft, text, started) {
  if (!draft.title) {
    const { title, body } = splitTitleBody(text);
    draft.title = title;
    if (body) draft.text.push(body);
  } else {
    draft.text.push(text);
  }
  return ctx.reply(addedReply(draft, started, "Added"), { reply_markup: doneInlineKeyboard() });
}

bot.on("message:text", (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const { draft, started } = draftForMessage(ctx);
  if (!draft) return ctx.reply(NO_REPO_HINT);
  return handleTextInput(ctx, draft, ctx.message.text, started);
});

bot.on("message:voice", async (ctx) => {
  const { draft, started } = draftForMessage(ctx);
  if (!draft) return ctx.reply(NO_REPO_HINT);
  if (!config.groqApiKey) {
    return ctx.reply("Voice transcription is not configured (no GROQ_API_KEY).");
  }

  const file = await ctx.api.getFile(ctx.message.voice.file_id);
  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());

  try {
    const text = await transcribeVoice(buffer, "voice.ogg");
    if (!text) return ctx.reply("Could not transcribe the voice message.");
    await ctx.reply(`Transcribed: ${text}`);
    return handleTextInput(ctx, draft, text, started);
  } catch (err) {
    console.error(err);
    return ctx.reply(`Transcription error: ${err.message}`);
  }
});

const KIND_LABEL = { image: "Image", video: "Video", file: "File" };

// Photo, video, GIF, round video or any file sent as a document -> what to download and how to
// show it in the issue. Images sent "as a file" still render as images.
function mediaOf(msg) {
  if (msg.photo) {
    const p = msg.photo[msg.photo.length - 1];
    return { fileId: p.file_id, filename: `${p.file_unique_id}.jpg`, kind: "image" };
  }
  const video = msg.video || msg.animation || msg.video_note;
  if (video) {
    return { fileId: video.file_id, filename: video.file_name || `${video.file_unique_id}.mp4`, kind: "video" };
  }
  const d = msg.document;
  const mime = d.mime_type || "";
  const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file";
  return { fileId: d.file_id, filename: d.file_name || d.file_unique_id, kind };
}

// The Bot API refuses to hand out files over 20 MB — getFile throws "file is too big".
async function downloadMedia(ctx, media) {
  const file = await ctx.api.getFile(media.fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// GitHub renders images from a raw link inline; videos and other files get a link to the file page
// in the media repo, where GitHub shows a player / preview.
function attachmentMarkdown(media, urls) {
  if (media.kind === "image") return `![image](${urls.raw})`;
  if (media.kind === "video") return `▶️ [Video: ${media.filename}](${urls.page})`;
  return `📎 [${media.filename}](${urls.page})`;
}

bot.on(
  ["message:photo", "message:video", "message:animation", "message:video_note", "message:document"],
  async (ctx) => {
  // No draft: the attachment goes to the last inline-mode issue if there is one (as before),
  // otherwise it starts a new issue in the chosen repo, like text and voice do.
  const lastIssue = getLastIssue(ctx.from.id);
  const { draft, started } =
    getDraft(ctx.chat.id) || !lastIssue ? draftForMessage(ctx) : { draft: null, started: false };
  if (!draft && !lastIssue) return ctx.reply(NO_REPO_HINT);

  const media = mediaOf(ctx.message);
  let buffer;
  try {
    buffer = await downloadMedia(ctx, media);
  } catch (err) {
    console.error(err);
    return ctx.reply(`Could not get the file from Telegram (bots can download up to 20 MB): ${err.message}`);
  }

  if (!draft) {
    try {
      const urls = await uploadAttachment(splitRepo(lastIssue.repo).repo, buffer, media.filename);
      const commentBody = [ctx.message.caption, attachmentMarkdown(media, urls)]
        .filter(Boolean)
        .join("\n\n");
      await addIssueComment(lastIssue.repo, lastIssue.number, commentBody);
      return ctx.reply(`Added to ${lastIssue.repo}#${lastIssue.number}: ${lastIssue.url}`);
    } catch (err) {
      console.error(err);
      return ctx.reply(`Could not add the ${media.kind}: ${err.message}`);
    }
  }

  draft.files.push({ ...media, buffer });

  if (ctx.message.caption) {
    if (!draft.title) {
      const { title, body } = splitTitleBody(ctx.message.caption);
      draft.title = title;
      if (body) draft.text.push(body);
    } else {
      draft.text.push(ctx.message.caption);
    }
  }

  return ctx.reply(
    addedReply(draft, started, `${KIND_LABEL[media.kind]} added (attachments: ${draft.files.length})`),
    { reply_markup: doneInlineKeyboard() }
  );
  }
);

function splitTitleBody(text) {
  const firstLine = text.split("\n")[0];
  const rest = text.slice(firstLine.length).trim();
  if (rest) return { title: firstLine.trim(), body: rest };
  const m = text.match(/^(.+?[.!?])(\s|$)/);
  if (m) return { title: m[1].trim(), body: text.slice(m[0].length).trim() };
  return { title: text.trim(), body: "" };
}

function matchRepos(prefix) {
  const p = prefix.toLowerCase();
  return config.repos.filter((r) => r.toLowerCase().includes(p)).slice(0, 8);
}

bot.on("inline_query", async (ctx) => {
  const query = ctx.inlineQuery.query;
  const slashIdx = query.lastIndexOf("/");
  if (slashIdx === -1) return ctx.answerInlineQuery([], { cache_time: 0 });

  const textPart = query.slice(0, slashIdx).trim();
  const repoPrefix = query.slice(slashIdx + 1).trim();
  if (!textPart) return ctx.answerInlineQuery([], { cache_time: 0 });

  const { title } = splitTitleBody(textPart);
  const results = matchRepos(repoPrefix).map((repo) =>
    InlineQueryResultBuilder.article(repo, repo, {
      description: title,
      reply_markup: new InlineKeyboard().url(repo, `https://github.com/${repo}`),
    }).text(`${textPart}\n\n⏳ Creating the issue in ${repo}…`)
  );
  return ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
});

bot.on("chosen_inline_result", async (ctx) => {
  const repo = ctx.chosenInlineResult.result_id;
  const query = ctx.chosenInlineResult.query;
  const textPart = query.slice(0, query.lastIndexOf("/")).trim();
  const { title, body } = splitTitleBody(textPart);

  try {
    const issue = await createIssue(repo, { title, body: body || "(no description)" });
    setLastIssue(ctx.chosenInlineResult.from.id, { repo, number: issue.number, url: issue.html_url });
    const startPayload = encodeIssueRef(repo, issue.number);
    const keyboard = new InlineKeyboard()
      .url(`Issue: ${repo}`, issue.html_url)
      .row()
      .url("📷 Send a photo to the bot", `https://t.me/${ctx.me.username}?start=${startPayload}`);
    await ctx.editMessageText(`${textPart}\n\n✅ ${repo}: ${issue.html_url}`, {
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error(err);
    await ctx.editMessageText(`${textPart}\n\n❌ ${repo}: error — ${err.message}`);
  }
});

bot.catch((err) => {
  console.error("Bot error:", err);
});

await bot.api.setMyCommands([
  { command: "newissue", description: "Start a new issue" },
  { command: "issues", description: "Open a repo's issues" },
  { command: "repo", description: "Set the repo for new issues" },
  { command: "done", description: "Create the issue from the draft" },
  { command: "status", description: "Show the current draft" },
  { command: "cancel", description: "Discard the draft" },
]);

await bot.api.setMyDescription(
  "Collects text, photos, videos, files and voice messages in chat and creates an issue in the repo(s) you pick on GitHub.\n\n" +
    "Pick a repo once — every new issue goes there until you change it with \"Set repo\". Send a title and description (text/photo/voice) — the bot creates the issue and gives you the link."
);
await bot.api.setMyShortDescription(
  "Creates GitHub issues from Telegram text, photos, and voice messages."
);

bot.start();
console.log("Bot started");
