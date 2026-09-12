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
import { uploadImage, createIssue, addIssueComment } from "./github.js";

const bot = new Bot(config.telegramToken);

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
    await ctx.reply("Доступ запрещён.");
    return;
  }
  await next();
});

const BTN_NEW = "🆕 Новый issue";
const BTN_DONE = "✅ Готово";
const BTN_STATUS = "📋 Статус";
const BTN_CANCEL = "❌ Отмена";
const BTN_ISSUES = "📂 Открыть issues";

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
  return ctx.reply("Открыть issues репозитория:", { reply_markup: repoLinksKeyboard("/issues") });
}

function repoKeyboard(draft) {
  const keyboard = new InlineKeyboard();
  for (const repo of config.repos) {
    const mark = draft.selectedRepos.has(repo) ? "✅ " : "";
    keyboard.text(`${mark}${repo}`, `repo:${repo}`).row();
  }
  keyboard.text("Дальше ▶", "confirm-repos");
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
    return ctx.reply(`Присылай фото — добавлю в ${repo}#${number}:\n${url}`);
  }

  return ctx.reply(
    "Привет! Я собираю текст и картинки в черновик issue и создаю его в GitHub.\n\n" +
      `${BTN_NEW} — начать новый issue\n${BTN_ISSUES} — быстрые ссылки на issues репо\n` +
      `${BTN_DONE} — создать issue из черновика\n${BTN_STATUS} — показать текущий черновик\n${BTN_CANCEL} — отменить черновик`,
    { reply_markup: mainKeyboard }
  );
}

function cancelHandler(ctx) {
  clearDraft(ctx.chat.id);
  return ctx.reply("Черновик отменён.");
}

function statusHandler(ctx) {
  const draft = getDraft(ctx.chat.id);
  if (!draft) return ctx.reply("Нет активного черновика. Жми «Новый issue».");
  return ctx.reply(
    `Шаг: ${draft.step}\nРепозитории: ${[...draft.selectedRepos].join(", ") || "(нет)"}\n` +
      `Заголовок: ${draft.title || "(нет)"}\nТекст: ${draft.text.length} сообщений\nКартинок: ${draft.images.length}`
  );
}

function newIssueHandler(ctx) {
  const draft = startDraft(ctx.chat.id);
  return ctx.reply(
    "Выбери один или несколько репозиториев (можно для общих задач), потом жми «Дальше ▶»:",
    { reply_markup: repoKeyboard(draft) }
  );
}

async function doneHandler(ctx) {
  const draft = getDraft(ctx.chat.id);
  if (!draft || draft.step !== STEP.BODY) {
    return ctx.reply("Сейчас нечего завершать. Жми «Новый issue».");
  }

  await ctx.reply(`Создаю issue в: ${[...draft.selectedRepos].join(", ")}…`);

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
        body: bodyParts.join("\n\n") || "(без описания)",
      });
      results.push(`${repo}: ${issue.html_url}`);
      okRepos.push(repo);
    } catch (err) {
      console.error(err);
      results.push(`${repo}: ошибка — ${err.message}`);
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
    await ctx.answerCallbackQuery({ text: "Черновик не найден." });
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
    await ctx.answerCallbackQuery({ text: "Выбери хотя бы один репозиторий." });
    return;
  }

  rememberRepoSelection(ctx.chat.id, draft.selectedRepos);
  draft.step = STEP.TITLE;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `Репозитории: ${[...draft.selectedRepos].join(", ")}\nТеперь отправь заголовок issue одним сообщением.`
  );
});

function handleTextInput(ctx, draft, text) {
  if (draft.step === STEP.TITLE) {
    draft.title = text;
    draft.step = STEP.BODY;
    return ctx.reply(
      `Заголовок сохранён. Теперь отправляй текст и/или картинки для описания issue.\nКогда закончишь — жми «${BTN_DONE}».`
    );
  }

  if (draft.step === STEP.BODY) {
    draft.text.push(text);
    return ctx.reply("Добавлено к описанию.");
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
    return ctx.reply("Распознавание голоса не настроено (нет GROQ_API_KEY).");
  }

  const file = await ctx.api.getFile(ctx.message.voice.file_id);
  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());

  try {
    const text = await transcribeVoice(buffer, "voice.ogg");
    if (!text) return ctx.reply("Не удалось разобрать голосовое.");
    await ctx.reply(`Распознано: ${text}`);
    return handleTextInput(ctx, draft, text);
  } catch (err) {
    console.error(err);
    return ctx.reply(`Ошибка распознавания: ${err.message}`);
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
      return ctx.reply(`Добавлено в ${lastIssue.repo}#${lastIssue.number}: ${lastIssue.url}`);
    } catch (err) {
      console.error(err);
      return ctx.reply(`Не удалось добавить картинку: ${err.message}`);
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

  return ctx.reply(`Картинка добавлена (всего: ${draft.images.length}).`);
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
    }).text(`${textPart}\n\n⏳ Создаю issue в ${repo}…`)
  );
  return ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
});

bot.on("chosen_inline_result", async (ctx) => {
  const repo = ctx.chosenInlineResult.result_id;
  const query = ctx.chosenInlineResult.query;
  const textPart = query.slice(0, query.lastIndexOf("/")).trim();
  const { title, body } = splitTitleBody(textPart);

  try {
    const issue = await createIssue(repo, { title, body: body || "(без описания)" });
    setLastIssue(ctx.chosenInlineResult.from.id, { repo, number: issue.number, url: issue.html_url });
    const startPayload = encodeIssueRef(repo, issue.number);
    const keyboard = new InlineKeyboard()
      .url(`Issue: ${repo}`, issue.html_url)
      .row()
      .url("📷 Дослать фото боту", `https://t.me/${ctx.me.username}?start=${startPayload}`);
    await ctx.editMessageText(`${textPart}\n\n✅ ${repo}: ${issue.html_url}`, {
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error(err);
    await ctx.editMessageText(`${textPart}\n\n❌ ${repo}: ошибка — ${err.message}`);
  }
});

bot.catch((err) => {
  console.error("Bot error:", err);
});

await bot.api.setMyCommands([
  { command: "newissue", description: "Начать новый issue" },
  { command: "issues", description: "Открыть issues репозитория" },
  { command: "done", description: "Создать issue из черновика" },
  { command: "status", description: "Текущий черновик" },
  { command: "cancel", description: "Отменить черновик" },
]);

await bot.api.setMyDescription(
  "Собирает текст, картинки и голосовые в чате и создаёт issue в выбранном GitHub-репозитории.\n\n" +
    "Жми «Новый issue», выбери один или несколько репо, пришли заголовок и описание (текст/фото/голос) — бот сам создаст issue со ссылкой."
);
await bot.api.setMyShortDescription(
  "Создаёт GitHub issue из текста, фото и голосовых сообщений в Telegram."
);

bot.start();
console.log("Bot started");
