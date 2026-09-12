import { Bot, InlineKeyboard, InlineQueryResultBuilder, Keyboard } from "grammy";
import { config } from "./config.js";
import {
  getDraft,
  startDraft,
  clearDraft,
  rememberRepoSelection,
  setLastIssue,
  getLastIssue,
  STEP,
} from "./session.js";
import { uploadImage, createIssue, addIssueComment, listRepos } from "./github.js";

const bot = new Bot(config.telegramToken);

if (config.repos.length === 0) {
  config.repos = await listRepos();
  console.log(`Auto-discovered ${config.repos.length} repos: ${config.repos.join(", ")}`);
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
const BTN_DONE = "✅ Done";
const BTN_STATUS = "📋 Status";
const BTN_CANCEL = "❌ Cancel";
const BTN_ISSUES = "📂 Open issues";

const mainKeyboard = new Keyboard()
  .text(BTN_NEW).text(BTN_ISSUES).row()
  .text(BTN_DONE).text(BTN_STATUS).text(BTN_CANCEL)
  .resized()
  .persistent();

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

function repoKeyboard(draft) {
  const keyboard = new InlineKeyboard();
  for (const repo of config.repos) {
    const mark = draft.selectedRepos.has(repo) ? "✅ " : "";
    keyboard.text(`${mark}${repo}`, `repo:${repo}`).row();
  }
  keyboard.text("Next ▶", "confirm-repos");
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
    "Hi! I collect text and images into an issue draft and create it on GitHub.\n\n" +
      `${BTN_NEW} — start a new issue\n${BTN_ISSUES} — quick links to repo issues\n` +
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
  if (!draft) return ctx.reply("No active draft. Tap \"New issue\" to start.");
  return ctx.reply(
    `Step: ${draft.step}\nRepos: ${[...draft.selectedRepos].join(", ") || "(none)"}\n` +
      `Title: ${draft.title || "(none)"}\nText: ${draft.text.length} message(s)\nImages: ${draft.images.length}`
  );
}

function newIssueHandler(ctx) {
  const draft = startDraft(ctx.chat.id);
  return ctx.reply(
    "Pick one or more repos (pick several for a shared issue), then tap \"Next ▶\":",
    { reply_markup: repoKeyboard(draft) }
  );
}

async function doneHandler(ctx) {
  const draft = getDraft(ctx.chat.id);
  if (!draft || draft.step !== STEP.BODY) {
    return ctx.reply("Nothing to finish right now. Tap \"New issue\" to start.");
  }

  await ctx.reply(`Creating the issue in: ${[...draft.selectedRepos].join(", ")}…`);

  const results = [];
  const okRepos = [];
  for (const repo of draft.selectedRepos) {
    try {
      const imageUrls = [];
      for (const img of draft.images) {
        const url = await uploadImage(repo, img.buffer, img.filename);
        imageUrls.push(url);
      }

      const bodyParts = [...draft.text];
      if (imageUrls.length > 0) {
        bodyParts.push("", ...imageUrls.map((u) => `![image](${u})`));
      }

      const issue = await createIssue(repo, {
        title: draft.title,
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
}

bot.command("start", startHandler);
bot.command("cancel", cancelHandler);
bot.command("status", statusHandler);
bot.command("newissue", newIssueHandler);
bot.command("done", doneHandler);
bot.command("issues", issuesHandler);

bot.hears(BTN_NEW, newIssueHandler);
bot.hears(BTN_DONE, doneHandler);
bot.hears(BTN_STATUS, statusHandler);
bot.hears(BTN_CANCEL, cancelHandler);
bot.hears(BTN_ISSUES, issuesHandler);

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const draft = getDraft(ctx.chat.id);
  if (!draft || draft.step !== STEP.REPO) {
    await ctx.answerCallbackQuery({ text: "Draft not found." });
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
  draft.step = STEP.TITLE;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `Repos: ${[...draft.selectedRepos].join(", ")}\nNow send the issue title as a single message.`
  );
});

function handleTextInput(ctx, draft, text) {
  if (draft.step === STEP.TITLE) {
    draft.title = text;
    draft.step = STEP.BODY;
    return ctx.reply(
      `Title saved. Now send text and/or images for the issue body.\nWhen you're done — tap "${BTN_DONE}".`
    );
  }

  if (draft.step === STEP.BODY) {
    draft.text.push(text);
    return ctx.reply("Added to the description.");
  }
}

bot.on("message:text", (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const draft = getDraft(ctx.chat.id);
  if (!draft) return;
  return handleTextInput(ctx, draft, ctx.message.text);
});

bot.on("message:voice", async (ctx) => {
  const draft = getDraft(ctx.chat.id);
  if (!draft) return;
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
    return handleTextInput(ctx, draft, text);
  } catch (err) {
    console.error(err);
    return ctx.reply(`Transcription error: ${err.message}`);
  }
});

bot.on("message:photo", async (ctx) => {
  const draft = getDraft(ctx.chat.id);

  if (!draft || draft.step !== STEP.BODY) {
    const lastIssue = getLastIssue(ctx.from.id);
    if (!lastIssue) return;

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const tgUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
    const res = await fetch(tgUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = file.file_path.split(".").pop() || "jpg";

    try {
      const imageUrl = await uploadImage(
        lastIssue.repo,
        buffer,
        `${photo.file_unique_id}.${ext}`
      );
      const commentBody = [ctx.message.caption, `![image](${imageUrl})`]
        .filter(Boolean)
        .join("\n\n");
      await addIssueComment(lastIssue.repo, lastIssue.number, commentBody);
      return ctx.reply(`Added to ${lastIssue.repo}#${lastIssue.number}: ${lastIssue.url}`);
    } catch (err) {
      console.error(err);
      return ctx.reply(`Could not add the image: ${err.message}`);
    }
  }

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const file = await ctx.api.getFile(photo.file_id);
  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = file.file_path.split(".").pop() || "jpg";

  draft.images.push({ buffer, filename: `${photo.file_unique_id}.${ext}` });

  if (ctx.message.caption) {
    draft.text.push(ctx.message.caption);
  }

  return ctx.reply(`Image added (total: ${draft.images.length}).`);
});

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
  { command: "done", description: "Create the issue from the draft" },
  { command: "status", description: "Show the current draft" },
  { command: "cancel", description: "Discard the draft" },
]);

await bot.api.setMyDescription(
  "Collects text, images and voice messages in chat and creates an issue in the repo(s) you pick on GitHub.\n\n" +
    "Tap \"New issue\", pick one or more repos, send a title and description (text/photo/voice) — the bot creates the issue and gives you the link."
);
await bot.api.setMyShortDescription(
  "Creates GitHub issues from Telegram text, photos, and voice messages."
);

bot.start();
console.log("Bot started");
