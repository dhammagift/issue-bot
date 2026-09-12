# issue-bot bot

Telegram-бот: собирает текст и картинки в чате и создаёт issue в выбранном GitHub-репозитории.

## Настройка

1. `cp .env.example .env` и заполнить:
   - `TELEGRAM_BOT_TOKEN` — токен от @BotFather
   - `GITHUB_TOKEN` — PAT с правом `repo`
   - `GITHUB_REPOS` — список репозиториев `owner/repo` через запятую
   - `ALLOWED_USER_IDS` — опционально, ограничить доступ по Telegram user id
2. `npm install`
3. `npm start`

## Использование

- `/newissue` — начать черновик, бот попросит заголовок
- отправь заголовок текстом
- дальше отправляй текст и/или фото — всё уйдёт в тело issue (фото коммитятся в репозиторий в папку `issue-images/` и вставляются в issue как markdown-картинки)
- `/done` — выбрать репозиторий из списка и создать issue
- `/status` — посмотреть текущий черновик
- `/cancel` — отменить черновик
