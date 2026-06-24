# telegram-remote

Drive this pi session from anywhere via a Telegram bot. DM your bot a prompt →
it's injected into your live session → the agent's reply is sent back to the chat.

Pure outbound HTTPS to `api.telegram.org` (long-poll `getUpdates` + `sendMessage`).
No inbound port, no public URL, no hosting — works behind home NAT. Telegram's
servers are the relay.

## Architecture

- **`core.ts`** — pure, unit-tested logic: `parseUpdates`, `extractReplyText`,
  `chunkMessage`. No I/O.
- **`index.ts`** — the I/O shell: config load, the polling loop, and the
  `session_start` / `agent_end` / `session_shutdown` wiring.

Run the tests with `npm test` (Node's built-in test runner via `tsx`).

## Setup (~2 min)

1. In your normal Telegram app, message **@BotFather**, send `/newbot`, follow the
   prompts, and copy the **bot token** it gives you (`123456789:AA...`).
2. Send your new bot any message (so it has a chat to reply to).
3. Find your **numeric chat id**: open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read
   `result[].message.chat.id`.
4. Create `~/.pi/telegram-remote.json` (gitignored) — see
   [`telegram-remote.example.json`](./telegram-remote.example.json):

   ```json
   {
     "botToken": "123456789:AA...",
     "chatId": 123456789,
     "deliverAs": "steer",
     "pollTimeoutSec": 30
   }
   ```

5. Start (or restart) pi. Activity is logged to `~/.pi/telegram-remote.log`.

If the config file is absent or invalid, the extension stays completely inert.

## Config

| Key | Default | Meaning |
|---|---|---|
| `botToken` | — (required) | Bot token from @BotFather |
| `chatId` | — (required) | Your numeric chat id; messages from any other chat are ignored |
| `deliverAs` | `"steer"` | `"steer"` injects into the current turn (submits immediately when idle); `"followUp"` queues after the current turn instead of interrupting |
| `pollTimeoutSec` | `30` | Long-poll hold time for `getUpdates` |

## Behaviour notes

- **Backlog is drained on startup** — messages you sent while pi was offline are
  discarded, not replayed, so stale prompts don't auto-run.
- **Only remote-initiated turns reply back.** Work you start at the local terminal
  is *not* mirrored to Telegram; only turns triggered by a Telegram message send
  their reply to the chat.
- **Replies over 4096 chars** are split into multiple messages on newline
  boundaries (Telegram's per-message limit).
- Only the chat id in your config is honored — a stranger who finds the bot is
  ignored. The token is the only secret; keep `telegram-remote.json` out of git.
