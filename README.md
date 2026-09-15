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

## Setup from scratch (Linux server)

The production instance runs on the dhamma.gift server as the pm2 process **`issue-bot`** in
`/var/www/issue_bot`. The steps below reproduce it on a clean machine.

1. Node.js 18+ and pm2 (skip what is already installed; `node -v`, `pm2 -v`):
   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
   source ~/.bashrc
   nvm install 24
   npm install -g pm2
   ```
2. Create the bot in Telegram: [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
3. Create the GitHub token: Settings → Developer settings → Fine-grained tokens, with access to the
   repos you file issues in plus the media repo (`dhammagift/issue-media`):
   - **Issues: Read and write** on the issue repos;
   - **Contents: Read and write** on the media repo — without it attachments fail with
     `403 Resource not accessible by personal access token`;
   - **Metadata: Read** (added automatically).
4. Clone and install:
   ```bash
   git clone git@github.com:dhammagift/issue-img.git /var/www/issue_bot
   cd /var/www/issue_bot
   npm ci
   ```
5. Copy the env template, fill it in and keep it private:
   ```bash
   cp .env.example .env
   chmod 600 .env
   ```
   | Variable | Required | Description |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
   | `GITHUB_TOKEN` | yes | Needs Issues write access on the target repos and Contents write access on the media repo |
   | `MEDIA_REPO` | no | `owner/repo` where attachments are committed. Default `dhammagift/issue-media` |
   | `GITHUB_REPOS` | no | Comma-separated `owner/repo` list. Leave empty to auto-discover every repo the token can access |
   | `ALLOWED_USER_IDS` | no | Comma-separated Telegram user IDs. Leave empty to allow anyone |
   | `GROQ_API_KEY` | no | Enables voice message transcription |

6. Try it in the foreground first (`Bot started` in the output, then send `/start` to the bot; Ctrl+C to stop):
   ```bash
   npm start
   ```
7. Run it under pm2 and make it survive reboots:
   ```bash
   pm2 start src/bot.js --name issue-bot --cwd /var/www/issue_bot
   pm2 save
   pm2 startup    # once per server: prints a command that installs the pm2 systemd unit, run it
   ```
8. Check:
   ```bash
   pm2 status issue-bot                      # online, restarts not growing
   pm2 logs issue-bot --lines 50 --nostream  # "Bot started", no errors
   ```

Only one copy may run per bot token: a second instance (another server, a forgotten `npm start`)
makes Telegram reject polling with `409 Conflict`.

### Everyday operations

```bash
pm2 restart issue-bot                         # after editing .env
cd /var/www/issue_bot && git pull && npm ci && pm2 restart issue-bot   # update
pm2 stop issue-bot                            # pause
pm2 delete issue-bot && pm2 save              # remove from pm2 for good
```

Renaming the pm2 process: `pm2 delete <old>`, then step 7 with the new `--name`, then `pm2 save`.

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
