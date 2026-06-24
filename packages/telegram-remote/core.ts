// Pure, side-effect-free logic for the telegram-remote extension.
// Kept separate from index.ts (the I/O shell) so it can be unit-tested.

export interface TelegramChat {
  id?: number;
}

export interface TelegramMessage {
  text?: string;
  chat?: TelegramChat;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface ParsedUpdates {
  /** Text of messages from the allowed chat, in arrival order. */
  messages: string[];
  /** Offset for the next getUpdates call (highest update_id + 1), or undefined if none. */
  nextOffset?: number;
}

export function parseUpdates(updates: TelegramUpdate[], allowedChatId: number): ParsedUpdates {
  const messages: string[] = [];
  let maxUpdateId: number | undefined;

  for (const update of updates) {
    if (maxUpdateId === undefined || update.update_id > maxUpdateId) {
      maxUpdateId = update.update_id;
    }
    const text = update.message?.text;
    if (text && update.message?.chat?.id === allowedChatId) {
      messages.push(text);
    }
  }

  return {
    messages,
    nextOffset: maxUpdateId === undefined ? undefined : maxUpdateId + 1,
  };
}

interface ContentBlock {
  type: string;
  text?: string;
}

export interface AgentMessageLike {
  role: string;
  content?: string | ContentBlock[];
}

/**
 * Split text into chunks no longer than maxLen, preferring newline boundaries.
 * A single line longer than maxLen is hard-split. Telegram's sendMessage limit
 * is 4096 chars, so agent replies are chunked before sending.
 */
export function chunkMessage(text: string, maxLen: number): string[] {
  if (!text) return [];

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of text.split("\n")) {
    // A single line longer than the limit: flush, then hard-split it.
    if (line.length > maxLen) {
      flush();
      for (let i = 0; i < line.length; i += maxLen) {
        chunks.push(line.slice(i, i + maxLen));
      }
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen) {
      flush();
      current = line;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks;
}

export function extractReplyText(messages: ReadonlyArray<AgentMessageLike>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;

    const text =
      typeof msg.content === "string"
        ? msg.content
        : (msg.content ?? [])
            .filter((block) => block.type === "text" && block.text)
            .map((block) => block.text)
            .join("\n");

    if (text.trim()) return text;
  }
  return "";
}

export function startHelpText(): string {
  return [
    "Welcome to pi's Telegram remote! 🎯",
    "",
    "Any message you send here gets injected into your live pi session.",
    "",
    "📋 *Ralph kanban commands* — manage tasks right from Telegram:",
    "",
    "• /ralph_list     — show the kanban board",
    "• /ralph_next     — pick the highest-priority unblocked task",
    "• /ralph_claim    — mark a task as in progress",
    "• /ralph_complete — finish a task",
    "• /ralph_add      — add a new task (title)",
    "• /ralph_progress — append a progress note",
    "",
    "💡 *Any other text* — send it straight to pi as a prompt.",
  ].join("\n");
}
