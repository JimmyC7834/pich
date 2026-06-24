import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUpdates, extractReplyText, chunkMessage, startHelpText } from "./core.ts";

// ── parseUpdates ──────────────────────────────────────────────────────────

test("parseUpdates extracts text from a message in the allowed chat", () => {
  const result = parseUpdates(
    [{ update_id: 10, message: { text: "hello pi", chat: { id: 555 } } }],
    555,
  );
  assert.deepEqual(result.messages, ["hello pi"]);
});

test("parseUpdates advances offset past ignored messages so they are not refetched", () => {
  const result = parseUpdates(
    [{ update_id: 41, message: { text: "from a stranger", chat: { id: 999 } } }],
    555,
  );
  assert.deepEqual(result.messages, []);
  assert.equal(result.nextOffset, 42);
});

test("parseUpdates skips updates with no message text (e.g. photos, service events)", () => {
  const result = parseUpdates(
    [
      { update_id: 1, message: { chat: { id: 555 } } },
      { update_id: 2, message: { text: "real one", chat: { id: 555 } } },
    ],
    555,
  );
  assert.deepEqual(result.messages, ["real one"]);
  assert.equal(result.nextOffset, 3);
});

test("parseUpdates returns undefined offset for an empty update list", () => {
  const result = parseUpdates([], 555);
  assert.deepEqual(result.messages, []);
  assert.equal(result.nextOffset, undefined);
});

test("parseUpdates returns multiple allowed messages in order", () => {
  const result = parseUpdates(
    [
      { update_id: 7, message: { text: "first", chat: { id: 555 } } },
      { update_id: 8, message: { text: "second", chat: { id: 555 } } },
    ],
    555,
  );
  assert.deepEqual(result.messages, ["first", "second"]);
  assert.equal(result.nextOffset, 9);
});

// ── extractReplyText ──────────────────────────────────────────────────────

test("extractReplyText joins the text blocks of the assistant message", () => {
  const text = extractReplyText([
    {
      role: "assistant",
      content: [
        { type: "text", text: "Line one." },
        { type: "text", text: "Line two." },
      ],
    },
  ]);
  assert.equal(text, "Line one.\nLine two.");
});

test("extractReplyText ignores thinking and toolCall blocks", () => {
  const text = extractReplyText([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "toolCall", id: "1", name: "bash", arguments: {} },
        { type: "text", text: "Done." },
      ],
    },
  ]);
  assert.equal(text, "Done.");
});

test("extractReplyText returns the last assistant message of the turn", () => {
  const text = extractReplyText([
    { role: "assistant", content: [{ type: "text", text: "intermediate" }] },
    { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
    { role: "assistant", content: [{ type: "text", text: "final answer" }] },
  ]);
  assert.equal(text, "final answer");
});

test("extractReplyText returns empty string when there is no assistant text", () => {
  assert.equal(extractReplyText([{ role: "user", content: "hi" }]), "");
  assert.equal(
    extractReplyText([
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "x", arguments: {} }] },
    ]),
    "",
  );
});

// ── chunkMessage ──────────────────────────────────────────────────────────

test("chunkMessage returns a single chunk when text is within the limit", () => {
  assert.deepEqual(chunkMessage("short message", 100), ["short message"]);
});

test("chunkMessage returns no chunks for empty text", () => {
  assert.deepEqual(chunkMessage("", 100), []);
});

test("chunkMessage splits on newline boundaries without exceeding the limit", () => {
  const chunks = chunkMessage("aaaa\nbbbb\ncccc", 9);
  // "aaaa\nbbbb" = 9 chars fits; adding "\ncccc" would exceed -> new chunk
  assert.deepEqual(chunks, ["aaaa\nbbbb", "cccc"]);
  for (const c of chunks) assert.ok(c.length <= 9);
});

test("chunkMessage hard-splits a single line longer than the limit", () => {
  const chunks = chunkMessage("abcdefghij", 4);
  assert.deepEqual(chunks, ["abcd", "efgh", "ij"]);
});

// ── startHelpText ───────────────────────────────────────────────────────────

test("startHelpText returns a non-empty string mentioning ralph", () => {
  const text = startHelpText();
  assert.ok(text.length > 50);
  assert.ok(text.toLowerCase().includes("ralph"));
  assert.ok(text.includes("/ralph_list"));
});
