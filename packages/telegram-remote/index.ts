/**
 * telegram-remote — drive this pi session from anywhere via a Telegram bot.
 *
 * Inbound : long-polls Telegram getUpdates and injects each message you send
 *           the bot as a user message (pi.sendUserMessage).
 * Outbound: on each agent_end for a remote-initiated turn, sends the agent's
 *           reply back to your Telegram chat.
 *
 * + ask_user_question tool override — forwards questions to Telegram when the
 *   turn was triggered from Telegram, or shows local dialogs otherwise.
 *
 * Pure HTTPS to api.telegram.org — no inbound port, no hosting, works behind NAT.
 *
 * Config (gitignored): ~/.pi/telegram-remote.json
 *   { "botToken": "123:ABC", "chatId": 12345,
 *     "deliverAs": "steer" | "followUp", "pollTimeoutSec": 30 }
 * If the file is absent or invalid, the extension stays inert.
 *
 * The functional core (parsing, reply extraction, chunking) lives in core.ts
 * and is unit-tested; this file is the I/O shell.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseUpdates, extractReplyText, chunkMessage, startHelpText, type TelegramUpdate } from "./core.js";
import { InputSchema, type Question, type Result } from "./schema.js";

const CONFIG_PATH = join(homedir(), ".pi", "telegram-remote.json");
const LOG_PATH = join(homedir(), ".pi", "telegram-remote.log");
const TELEGRAM_MAX = 4096;

interface Config {
  botToken: string;
  chatId: number;
  deliverAs: "steer" | "followUp";
  pollTimeoutSec: number;
}

function log(msg: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function loadConfig(): Config | null {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    return null; // not configured — stay inert, no noise
  }
  try {
    const cfg = JSON.parse(raw) as Partial<Config>;
    if (typeof cfg.botToken !== "string" || typeof cfg.chatId !== "number") {
      log("config invalid: botToken (string) and chatId (number) are required");
      return null;
    }
    return {
      botToken: cfg.botToken,
      chatId: cfg.chatId,
      deliverAs: cfg.deliverAs === "followUp" ? "followUp" : "steer",
      pollTimeoutSec: typeof cfg.pollTimeoutSec === "number" ? cfg.pollTimeoutSec : 30,
    };
  } catch {
    log("config is not valid JSON");
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callTelegram(
  token: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; result?: unknown }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal,
  });
  return (await res.json()) as { ok: boolean; result?: unknown };
}

export default function (pi: ExtensionAPI): void {
  const config = loadConfig();
  if (config) start(pi, config);
}

// ── ask_user_question helpers ─────────────────────────────────────────────

function formatQuestionBlock(q: Question, idx: number): string {
  const lines: string[] = [];
  lines.push(`Q${idx + 1}: ${q.question}`);
  if (q.multiSelect) lines.push("  (multi-select — separate answers with commas)");
  lines.push("");
  q.options.forEach((opt, i) => {
    const desc = opt.description ? ` — ${opt.description}` : "";
    lines.push(`  ${i + 1}. ${opt.label}${desc}`);
  });
  lines.push(`  ${q.options.length + 1}. Type your own answer...`);
  lines.push("");
  if (q.multiSelect) {
    lines.push("Reply with: option numbers (e.g. 1,3) or labels (e.g. Option A, Option C)");
  } else {
    lines.push("Reply with: option number, label, or free-text");
  }
  return lines.join("\n");
}
function tryParseSingle(raw: string, q: Question): string {
  // Try number(s) first
  const trimmed = raw.trim();
  if (q.multiSelect) {
    const parts = trimmed.split(/[,;]\s*/).map((s) => s.trim());
    const labels: string[] = [];
    for (const part of parts) {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num >= 1 && num <= q.options.length) {
        labels.push(q.options[num - 1].label);
      } else {
        // Try exact match with an option label
        const match = q.options.find(
          (o) => o.label.toLowerCase() === part.toLowerCase(),
        );
        if (match) labels.push(match.label);
        else labels.push(part); // treat as free-text
      }
    }
    return labels.length > 0 ? labels.join(", ") : q.options[0].label;
  }

  // Single-select
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= q.options.length) {
    return q.options[num - 1].label;
  }
  const match = q.options.find(
    (o) => o.label.toLowerCase() === trimmed.toLowerCase(),
  );
  if (match) return match.label;
  return trimmed; // free-text fallback
}

// A TUI component that renders to no lines. Used by the ask_user_question
// renderers to occupy the tool-execution row without drawing anything.
function emptyComponent(): any {
  return { render(): string[] { return []; } };
}

// ── Extension body ────────────────────────────────────────────────────────

function start(pi: ExtensionAPI, config: Config): void {
  const controller = new AbortController();
  let offset: number | undefined;
  let polling = false;
  let pendingRemoteReply = false;
  let remoteSession = false; // whether current turn was triggered from Telegram
  // Deferred promise for pending ask_user_question — resolved with raw text from Telegram
  let pendingQuestion: ((text: string | null) => void) | null = null;
  async function sendReply(text: string): Promise<void> {
    for (const chunk of chunkMessage(text, TELEGRAM_MAX)) {
      try {
        await callTelegram(config.botToken, "sendMessage", {
          chat_id: config.chatId,
          text: chunk,
          // ponytail: no parse_mode — plain text works everywhere
        });
      } catch (e) {
        log(`sendMessage failed: ${String(e)}`);
      }
    }
  }

  // ── Tool override: ask_user_question (registered AFTER all extensions load) ──
  function registerQuestionTool(): void {
    pi.registerTool({
      name: "ask_user_question",
      label: "Ask User",
      description: `Ask the user 1–4 clarifying questions before proceeding.
Use this tool to:
1. Clarify ambiguous instructions
2. Get the user's preference between valid approaches
3. Make decisions on implementation choices
4. Offer choices about what direction to take
Each question must have 2–4 options. Users can always select "Other" to type a free-text answer, so do not include an "Other" option yourself.
Option labels should be concise (1–5 words).
Set multiSelect: true when more than one option can validly apply at the same time.
The header field is a short label (max 12 characters) used in the tab bar when showing multiple questions.
If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.
Always use this tool instead of asking questions in plain text — it provides a structured, interactive UI.`,

      parameters: InputSchema,

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (!remoteSession) {
          // Local session — use simple dialogs
          return handleLocally(params.questions, ctx, signal);
        }

        // Remote Telegram session — send questions one at a time
        const answers: Record<string, string> = {};
        for (let i = 0; i < params.questions.length; i++) {
          const q = params.questions[i];
          const block = formatQuestionBlock(q, i);
          const prompt = i === 0
            ? block
            : `Question ${i + 1} of ${params.questions.length}:\n\n${block}`;
          await sendReply(prompt);

          const reply = await new Promise<string | null>((resolve) => {
            pendingQuestion = (rawText) => {
              if (rawText === null) { resolve(null); return; }
              resolve(tryParseSingle(rawText, q));
            };
            if (signal) {
              const onAbort = () => {
                pendingQuestion = null;
                resolve(null);
                signal.removeEventListener("abort", onAbort);
              };
              signal.addEventListener("abort", onAbort);
            }
          });

          if (reply === null) {
            return {
              content: [{ type: "text" as const, text: "User cancelled" }],
              details: { questions: params.questions, answers: {}, cancelled: true } satisfies Result,
            };
          }
          answers[q.question] = reply;
        }

        const summaryLines = params.questions.map(
          (q) => `"${q.question}" = "${answers[q.question] ?? "(no answer)"}"`,
        );

        return {
          content: [{ type: "text" as const, text: summaryLines.join("\n") }],
          details: { questions: params.questions, answers, cancelled: false } satisfies Result,
        };
      },

      // Render nothing in the TUI — the interaction happens via local dialogs
      // or Telegram. The framework adds the returned component as a child and
      // later calls child.render(), so we must return a real component that
      // renders to no lines (returning undefined crashes Box.render).
      renderCall() { return emptyComponent(); },
      renderResult() { return emptyComponent(); },
    });
  }

  // ── Polling loop ────────────────────────────────────────────────────
  async function pollLoop(): Promise<void> {
    if (polling) return;
    polling = true;
    log(`polling started (deliverAs=${config.deliverAs}, timeout=${config.pollTimeoutSec}s)`);

    // Drain any backlog received while pi was offline so stale prompts don't replay.
    let draining = true;

    while (polling) {
      try {
        const data = await callTelegram(
          config.botToken,
          "getUpdates",
          { offset, timeout: draining ? 0 : config.pollTimeoutSec },
          controller.signal,
        );

        if (!data.ok) {
          log("getUpdates returned ok=false");
          draining = false;
          await sleep(2000);
          continue;
        }

        const updates = (data.result as TelegramUpdate[]) ?? [];
        const parsed = parseUpdates(updates, config.chatId);
        if (parsed.nextOffset !== undefined) offset = parsed.nextOffset;

        if (draining) {
          // Keep draining (timeout=0) until the backlog is empty, injecting nothing.
          if (updates.length > 0) {
            log(`drained ${updates.length} backlog update(s)`);
            continue;
          }
          draining = false;
          continue;
        }

        for (const text of parsed.messages) {
          log(`recv: ${text.slice(0, 120)}`);

          // /start (or /start@BotUsername) → reply with help text, don't send to pi
          if (text === "/start" || text.startsWith("/start@") || text.startsWith("/start ")) {
            await sendReply(startHelpText());
            continue;
          }
          // If there's a pending ask_user_question, resolve it with the raw text
          if (pendingQuestion) {
            const resolve = pendingQuestion;
            pendingQuestion = null;
            resolve(text);
            continue;
          }

          pendingRemoteReply = true;
          remoteSession = true;
          try {
            await pi.sendUserMessage(text, { deliverAs: config.deliverAs });
          } catch (e) {
            log(`sendUserMessage failed: ${String(e)}`);
          }
        }
      } catch (e) {
        if (controller.signal.aborted) break;
        log(`poll error: ${String(e)}`);
        await sleep(3000);
      }
    }
    log("polling stopped");
  }
  pi.on("session_start", () => {
    void pollLoop();
    registerQuestionTool();
  });

  pi.on("agent_end", async (event) => {
    if (!pendingRemoteReply) {
      // Not a Telegram-initiated turn — reset remoteSession for next turn
      remoteSession = false;
      return;
    }
    pendingRemoteReply = false;
    const text = extractReplyText(event.messages as Parameters<typeof extractReplyText>[0]);
    if (text) await sendReply(text);
  });

  pi.on("session_shutdown", () => {
    polling = false;
    controller.abort();
  });
}

// ── Local session handler ─────────────────────────────────────────────────

async function handleLocally(
  questions: Question[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
) {
  if (!ctx.hasUI) {
    // No UI — disable the tool
    ctx.ui.notify?.("ask_user_question requires an interactive session", "warning");
    return {
      content: [{ type: "text" as const, text: "Error: ask_user_question requires an interactive session." }],
      details: { questions, answers: {}, cancelled: true } satisfies Result,
    };
  }

  const answers: Record<string, string> = {};
  let cancelled = false;

  for (const q of questions) {
    let answer: string | undefined;

    if (q.multiSelect) {
      // Multi-select: prompt user to type comma-separated choices
      const optionsText = q.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
      const prompt = `${q.question}\n\n${optionsText}\n\nEnter option numbers (e.g. 1,3) or free-text:`;
      answer = await ctx.ui.input(prompt, "1");
    } else if (q.options.length <= 9) {
      // Single-select with options: use select dialog
      const choices = q.options.map((o) => o.label);
      answer = await ctx.ui.select(q.question, choices);
    } else {
      // Fallback to text input
      answer = await ctx.ui.input(q.question, "");
    }

    if (answer === undefined) {
      cancelled = true;
      break;
    }
    answers[q.question] = answer;
  }

  if (cancelled) {
    return {
      content: [{ type: "text" as const, text: "User cancelled" }],
      details: { questions, answers: {}, cancelled: true } satisfies Result,
    };
  }

  const summaryLines = questions.map(
    (q) => `"${q.question}" = "${answers[q.question] ?? "(no answer)"}"`,
  );

  return {
    content: [{ type: "text" as const, text: summaryLines.join("\n") }],
    details: { questions, answers, cancelled: false } satisfies Result,
  };
}
