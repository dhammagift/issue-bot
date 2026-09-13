# issue-bot

A Telegram bot that turns chat messages — text, photos, videos, files and voice notes — into GitHub issues, without leaving Telegram.

## Features

- **Set the repo once.** Pick one or more repos with "Set repo" — the choice is saved (survives restarts) and every new issue goes there until you change it. Just send a title, then any mix of text, photos, videos, files and voice messages; "Press when done" creates the issue in every selected repo at once — handy for cross-repo bugs.
- **Voice-to-text.** Voice messages are transcribed via the Groq API (free tier, Whisper large-v3-turbo) and dropped straight into the draft as text.
- **Attachments live in a separate media repo.** Photos, videos, GIFs, round videos and files sent as documents are committed to `MEDIA_REPO` (default `dhammagift/issue-media`), in a folder named after the issue's repo, so working repos don't grow. Images are embedded in the issue; videos and files are linked to their GitHub file page. Telegram lets bots download files up to 20 MB.
- **Auto-discovers your repos.** If you don't hardcode a repo list, the bot lists every repository your `GITHUB_TOKEN` can see and lets you pick from those.
- **Inline mode, from any chat.** Type `@your_bot some text /repo` in any chat (even ones the bot isn't in) to get live repo-name suggestions and create a quick text-only issue with one tap — the first sentence becomes the title, the rest becomes the body.
- **Follow-up photos for inline issues.** An inline-created issue gets a "send a photo" button that deep-links back into a private chat with the bot; any photo, video or file you send there is uploaded and posted as a comment on that exact issue.
- **Quick links.** A one-tap shortcut lists every repo's `/issues` page.
- **Access control.** Restrict who can use the bot by Telegram user ID.
- **Self-configuring bot profile.** Command list, bot description and short description are pushed to Telegram automatically on startup.

## Requirements

- Node.js 18+
- A Telegram bot token ([@BotFather](https://t.me/BotFather))
- A GitHub token with `repo` (or fine-grained: Contents + Issues read/write) access to the repos you want to file issues in
- (Optional) A free [Groq API key](https://console.groq.com/keys) for voice transcription

## Setup

1. Clone and install:
   ```bash
   git clone <this-repo>
   cd issue-bot
   npm install
   ```
2. Copy the env template and fill it in:
   ```bash
   cp .env.example .env
   ```
   | Variable | Required | Description |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
   | `GITHUB_TOKEN` | yes | Needs Issues write access on the target repos and Contents write access on the media repo |
   | `MEDIA_REPO` | no | `owner/repo` where attachments are committed. Default `dhammagift/issue-media` |
   | `GITHUB_REPOS` | no | Comma-separated `owner/repo` list. Leave empty to auto-discover every repo the token can access |
   | `ALLOWED_USER_IDS` | no | Comma-separated Telegram user IDs. Leave empty to allow anyone |
   | `GROQ_API_KEY` | no | Enables voice message transcription |

3. Start it:
   ```bash
   npm start
   ```
   For production, run it under a process manager, e.g. [pm2](https://pm2.keymetrics.io/):
   ```bash
   pm2 start src/bot.js --name issue-bot
   ```

### Enabling inline mode (optional, one-time, via @BotFather)

To use the `@your_bot text /repo` inline feature:

1. `/mybots` → your bot → **Bot Settings → Inline Mode → Turn on**
2. Same menu → **Inline Feedback → 100%** (required — without it the bot never learns which suggestion you picked, so the placeholder message never gets updated with the real issue link)
3. (Optional, cosmetic) **Bot Settings → Mini Apps → Main App → Enable**, pointing at any URL — this makes Telegram show a persistent "Open" shortcut for the bot in its chat list and next to the message box.

## Usage

**Chat flow:**
- 📁 **Set repo** — pick repo(s) once; after that just send a title, then text / photos / videos / files / voice notes
- ✅ **Press when done** — creates the issue(s), posts the link, then says where the next issue will go
- 📂 **Open issues** — quick links to each repo's issues page
- 📋 **Status** / ❌ **Cancel** — inspect or discard the current draft

**Inline mode (any chat):**
```
@your_bot Login page throws a 500 on mobile /dg-node
```
Pick a suggested repo → issue is created immediately with the title = first sentence, body = the rest. Tap "📷 Send a photo" on the result afterwards to attach images to that same issue.
