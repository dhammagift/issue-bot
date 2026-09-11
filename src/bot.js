import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { getDraft, startDraft, clearDraft, STEP } from "./session.js";
import { uploadImage, createIssue } from "./github.js";

const bot = new Bot(config.telegramToken);

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

bot.command("start", (ctx) =>
  ctx.reply(
    "Привет! Я собираю текст и картинки в черновик issue и создаю его в GitHub.\n\n" +
      "/newissue — начать новый issue\n" +
      "/cancel — отменить черновик\n" +
      "/status — показать текущий черновик"
  )
);

bot.command("cancel", (ctx) => {
  clearDraft(ctx.chat.id);
  return ctx.reply("Черновик отменён.");
});

bot.command("status", (ctx) => {
  const draft = getDraft(ctx.chat.id);
  if (!draft) return ctx.reply("Нет активного черновика. /newissue чтобы начать.");
  return ctx.reply(
    `Шаг: ${draft.step}\nЗаголовок: ${draft.title || "(нет)"}\nТекст: ${draft.text.length} сообщений\nКартинок: ${draft.images.length}`
  );
});

bot.command("newissue", (ctx) => {
  startDraft(ctx.chat.id);
  return ctx.reply("Отправь заголовок issue одним сообщением.");
});

bot.command("done", async (ctx) => {
  const draft = getDraft(ctx.chat.id);
  if (!draft || draft.step !== STEP.BODY) {
    return ctx.reply("Сейчас нечего завершать. /newissue чтобы начать.");
  }
  draft.step = STEP.REPO;
  const keyboard = new InlineKeyboard();
  for (const repo of config.repos) {
    keyboard.text(repo, `repo:${repo}`).row();
  }
  return ctx.reply("Выбери репозиторий:", { reply_markup: keyboard });
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith("repo:")) return;

  const draft = getDraft(ctx.chat.id);
  if (!draft || draft.step !== STEP.REPO) {
    await ctx.answerCallbackQuery({ text: "Черновик не найден." });
    return;
  }

  const repo = data.slice("repo:".length);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`Репозиторий: ${repo}\nСоздаю issue…`);

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

    clearDraft(ctx.chat.id);
    await ctx.reply(`Issue создан: ${issue.html_url}`);
  } catch (err) {
    console.error(err);
    await ctx.reply(`Ошибка при создании issue: ${err.message}`);
  }
});

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const draft = getDraft(ctx.chat.id);
  if (!draft) return;

  if (draft.step === STEP.TITLE) {
    draft.title = ctx.message.text;
    draft.step = STEP.BODY;
    return ctx.reply(
      "Заголовок сохранён. Теперь отправляй текст и/или картинки для описания issue.\nКогда закончишь — /done."
    );
  }

  if (draft.step === STEP.BODY) {
    draft.text.push(ctx.message.text);
    return ctx.reply("Добавлено к описанию.");
  }
});

bot.on("message:photo", async (ctx) => {
  const draft = getDraft(ctx.chat.id);
  if (!draft || draft.step !== STEP.BODY) return;

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

bot.catch((err) => {
  console.error("Bot error:", err);
});

bot.start();
console.log("Bot started");
