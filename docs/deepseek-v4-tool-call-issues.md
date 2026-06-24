# DeepSeek V4 Pro & V4 Flash — Documented Tool-Calling Failures

Sources: [deepseek-harness](https://github.com/HenryZ838978/deepseek-harness) (270 trials, $2.50, 2026-05-09), [deepseek-compat-kit](https://github.com/xiaoshuo1988130/deepseek-compat-kit), Ahmad Awais / Command Code tool repairs, DeepSeek API Docs, community issues (vllm, langchain, pydantic-ai, openclaw, hermes-agent, factory, hindsight, litellm, laravel/ai).

---

## Layer 1: Protocol / API Contract Issues

These break for **everyone** using V4 with tools, regardless of client implementation.

### 1. Reasoning Content Lifecycle 400

**The #1 cause of "tool calls don't work" with DeepSeek V4.**

When thinking mode is enabled (**default**), if you send a multi-turn tool-calling conversation and re-send a prior assistant message that had `tool_calls`, you **must** preserve its `reasoning_content` field. Omit it → `HTTP 400: The reasoning_content in the thinking mode must be passed back to the API.`

- Reproduced 3/3 on both V4-Pro and V4-Flash
- Most agent frameworks strip unknown fields from assistant messages → silent breakage
- You MAY strip `reasoning_content` across user-turn boundaries (only required within a tool-calling turn chain)
- Affects: anything-llm#5683, hermes-agent#17400, openclaw#72044, Factory-AI#1018, langchain#3765, zooclaw.ai
- DeepSeek's 4.24 fix was reported as incomplete for multi-turn with `thinking_level="high"`

**Fix:** Preserve `msg.reasoning_content` on assistant messages that contain `tool_calls`.

```python
msg = response.choices[0].message
history.append({
    "role": "assistant",
    "content": msg.content,
    "tool_calls": _serialize_tool_calls(msg.tool_calls),
    "reasoning_content": getattr(msg, "reasoning_content", None),  # ← REQUIRED
})
```

---

### 2. `tool_choice="required"` and Specific Function `tool_choice` Rejected

Thinking mode only supports `"auto"` and `"none"`. Using `"required"` or `{"type":"function","function":{"name":"..."}}` returns:
```
HTTP 400: Thinking mode does not support this tool_choice
```

- Affects: `deepseek-v4-pro` and `deepseek-v4-flash` (NOT `deepseek-chat` V3.2)
- Breaks structured output in **every** major framework: LangChain `with_structured_output`, AutoGen, CrewAI, pydantic-ai, etc.
- DeepSeek's own Oh My Pi integration guide sets `supportsToolChoice: false` for V4
- LangChain workaround: `disabled_params={"tool_choice": None}` → but then model chooses not to call the tool ~40% of the time
- Issue: [deepseek-ai/DeepSeek-V3#1376](https://github.com/deepseek-ai/DeepSeek-V3/issues/1376)
- Fixes merged in [litellm#27628](https://github.com/BerriAI/litellm/pull/27628) (convert to `"auto"`), [hindsight#1294](https://github.com/vectorize-io/hindsight/pull/1294)

**Fix:** Either disable thinking for the call, or accept `"auto"` only (model may choose not to call).

---

### 3. Even `tool_choice="auto"` Can Cause 400 on Some Frameworks

Some agent frameworks send `tool_choice="auto"` explicitly and still get HTTP 400 from V4. Since omitting `tool_choice` is semantically identical to `"auto"` per the OpenAI API spec, the fix is to strip it entirely for DeepSeek V4.

- [hindsight#1294](https://github.com/vectorize-io/hindsight/pull/1294)

**Fix:** Omit `tool_choice` entirely for V4 models (don't even send `"auto"`).

---

### 4. `/anthropic` vs `/v1` Endpoint Difference for `tool_choice`

DeepSeek exposes both OpenAI-compatible (`/v1`) and Anthropic-compatible (`/anthropic`) endpoints. The behavior differs:

| `tool_choice` | `/v1` (OpenAI) | `/anthropic` |
|---|---|---|
| `"required"` / `{"type":"any"}` | ❌ 400 | ✅ 200 |
| specific function dict | ❌ 400 | ✅ 200 |
| `"auto"` / `"none"` | ✅ | ✅ |

- Documented in [deepseek-ai/DeepSeek-V3#1376](https://github.com/deepseek-ai/DeepSeek-V3/issues/1376) (2026-06-04 update)
- If you need forced tool calls and cannot disable thinking, use the `/anthropic` endpoint

**Fix:** Route forced-tool-choice requests through `/anthropic` endpoint, or disable thinking.

---

### 5. `/beta` Endpoint Remap Breaks Tool Choice

DeepSeek's beta endpoint (`api.deepseek.com/beta`) silently remaps `deepseek-v4-pro` → legacy `deepseek-reasoner`, which rejects `tool_choice={"type":"function","function":{"name":"..."}}` with HTTP 400.

- However, strict mode (`strict: true`) requires the `/beta` endpoint — creating a catch-22 if you need both strict mode and tool_choice

**Fix:** Use `api.deepseek.com` (non-beta) for all tool-using flows. Test strict mode separately.

---

### 6. Parallel Tool Call Delta Interleaving (Streaming)

When multiple tool calls are made in parallel, streaming chunks interleave arguments across `tc.index`, *not* in list order. Naive `list.append` aggregation produces corrupted arguments.

- Confirmed by [deepseek-harness](https://github.com/HenryZ838978/deepseek-harness) (100% interleave on 3/3 trials)

**Fix:** Aggregate by `tc.index` dict (`dict[int, slot]`), not by list position.

```python
tool_call_acc: dict[int, dict] = {}
for chunk in stream:
    for tc in (chunk.choices[0].delta.tool_calls or []):
        slot = tool_call_acc.setdefault(tc.index, {"id": None, "name": None, "arguments": ""})
        if tc.id: slot["id"] = tc.id
        if tc.function and tc.function.name: slot["name"] = tc.function.name
        if tc.function and tc.function.arguments: slot["arguments"] += tc.function.arguments
```

---

### 7. Empty Stream Chunks

DeepSeek emits ~3 chunks per response with `choices == []` (only `usage` populated). Naive clients crash on truthiness checks.

**Fix:**
```python
for chunk in stream:
    choices = chunk.choices or []
    if not choices:
        if chunk.usage is not None: usage = chunk.usage
        continue
```

---

### 8. DSML Fragment Leaking in Auto + Streaming Mode (Self-Hosted vLLM)

When self-hosting V4 with vLLM in auto tool-choice + streaming mode, DSML structural tags intermittently leak into the content stream, causing unstable tool-call parsing and corrupted arguments.

- [vllm#40801](https://github.com/vllm-project/vllm/issues/40801)

**Fix:** Non-streaming mode as workaround. Upstream vLLM fix in progress.

---

### 9. Incorrect Structured Output When Thinking Enabled (Self-Hosted vLLM)

When using `response_format: {"type": "json_object"}` with thinking enabled, the model outputs the JSON content in the `reasoning` field instead of the `content` field. The `content` field comes back as `None` or empty, breaking downstream JSON extraction.

- [vllm#41132](https://github.com/vllm-project/vllm/issues/41132)
- Affects: `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v3.2`

**Fix:** Disable thinking when using JSON structured output mode. These are mutually conflicting concerns on self-hosted vLLM.

---

### 10. Hard Context Ceiling at 1,048,576 Tokens

Not advertised in the model card. The server enforces exactly `2^20 = 1,048,576` tokens total (messages + max_tokens). Exceeding this returns 400.

- Confirmed by [deepseek-harness](https://github.com/HenryZ838978/deepseek-harness) probe_6b

---

### 11. NVIDIA NIM: Streaming Tool Calls Don't Continue

On NVIDIA NIM deployments, streaming tool calls from V4-Pro and V4-Flash do not continue to tool result in Anthropic-compatible agent workflows (Claude Code). The conversation returns to prompt or gets interrupted after the first tool call.

- [NVIDIA Developer Forums](https://forums.developer.nvidia.com/t/deepseek-v4-pro-v4-flash-on-nvidia-nim-streaming-tool-calls-do-not-continue-in-claude-code-anthropic-compatible-agent-workflow/368085)

---

## Layer 2: Schema / Argument Format Issues

These hit agents with strict validation (Zod, Pydantic, JSON Schema validators).

### 12. Null for Optional Fields

Instead of omitting an optional parameter, the model sends `null`. Strict validators (Zod, Pydantic) reject this — they expect `undefined`/absent, not `null`.

**Example:** A `shell` tool with optional `timeout` parameter. Model sends `{"command": "cat file", "timeout": null}` instead of `{"command": "cat file"}`.

**Fix:** Deterministic repair — strip `null` values for optional fields, or coerce to empty.

---

### 13. JSON Array Encoded as String

Model emits a JSON array *as a string* when the schema expects a native array.

**Example:** Schema expects `files: string[]`, model sends `files: "[\"a.txt\", \"b.txt\"]"`.

**Fix:** JSON.parse the string and validate.

---

### 14. Empty JS Object as Argument Placeholder

Model sends `{}` where it should send a value or omit the parameter entirely.

**Example:** `{"command": "ls", "timeout": {}}` instead of `{"command": "ls"}`.

**Fix:** Strip empty objects.

---

### 15. Boolean Parameters as Quoted Strings

Boolean values returned as `"true"` / `"false"` (strings) instead of `true` / `false` (booleans). Causes downstream schema rejection in strict validators.

- [vllm#41122](https://github.com/vllm-project/vllm/issues/41122)

---

### 16. JSON Bracket Mismatch (Deep Nesting Instability)

DeepSeek V3 and V4 lose bracket-pair state when generating deeply nested JSON (≥5 levels deep). At 9 levels, nearly always produces unparseable JSON.

- [deepseek-ai/DeepSeek-V3#1256](https://github.com/deepseek-ai/DeepSeek-V3/issues/1256)
- Affects tool call arguments with complex nested schemas

---

### 17. Parameter Hallucination (Undefined Parameters)

DeepSeek API docs explicitly warn: **the model may hallucinate parameters not defined in your function schema.** V4's deeper reasoning may generate more complex (and occasionally malformed) args.

- [DeepSeek API Function Calling Guide](https://api-docs.deepseek.com/guides/function_calling): *"The model does not always generate valid JSON, and may hallucinate parameters not defined by your function schema — validate the arguments in your code before calling your function."*

**Fix:** Always wrap `json.loads(tool.function.arguments)` in try/except. Validate args against schema before execution. Implement retry logic with error context injected.

---

### 18. Invalid JSON in Tool Arguments

The model can return unparseable JSON in `tool_call.function.arguments`. DeepSeek internal testing shows JSON parsing rate improved from 78% → 85% → 97% across versions, meaning 3% of tool calls still have malformed JSON.

**Fix:** Multi-retry loop with injected error context:
```python
def run_with_retry(messages, tools, max_retries=3):
    for attempt in range(max_retries):
        message = send_messages(messages, tools)
        try:
            args = json.loads(message.tool_calls[0].function.arguments)
            return args, message
        except json.JSONDecodeError as e:
            messages.append({"role": "user", "content": f"Invalid JSON. Try again. Error: {e}"})
    raise ValueError("Tool call failed after retries")
```

---

### 19. `finish_reason="length"` Silently Truncates JSON

When the model hits `max_tokens` mid-JSON output, `finish_reason` is `"length"` and the JSON is truncated mid-object. If you don't check `finish_reason`, you parse an incomplete string.

**Fix:** Always check `finish_reason` before parsing. If `"length"`, the output is incomplete — retry with higher `max_tokens`.

---

### 20. `response_format: json_object` Requires "json" in Prompt

When using JSON output mode (`{"type": "json_object"}`), the API enforces that the word **"json"** must appear in the system or user prompt. Omit it → API error.

- Documented in DeepSeek API docs and [Macaron guide](https://macaron.im/blog/deepseek-v4-tool-calling)

**Fix:** Always include the word "json" in the prompt when using `response_format`.

---

### 21. Tool Call Leakage Into Content Field (V3 legacy, V4 likely clean)

Model outputs tool call instructions as plain text inside the `content` field instead of the `tool_calls` object. `finish_reason` is `"stop"` instead of `"tool_calls"`.

- V3 community rate: ~11%
- V4 official endpoint: 0% in 50 trials (seems silently fixed, but re-verify per release)
- [deepseek-ai/DeepSeek-V3#1244](https://github.com/deepseek-ai/DeepSeek-V3/issues/1244)

---

### 22. Length-Cut on Thinking + Tools → Empty Response

When thinking mode is enabled and context + thinking tokens approach the `max_tokens` limit, the model sometimes emits a message with empty `content` + empty `tool_calls`. Effectively a no-op turn.

**Fix:** Set `max_tokens` sufficiently high; disable thinking when not needed.

---

### 23. V4 DSML Tool Parser: Wrapped and Reserved Arguments (Self-Hosted)

When using vLLM's `deepseek_v4` tool-call parser with auto tool choice, wrapped arguments and reserved argument names (e.g., `arguments`, `name`) can be mishandled — the parser wraps them incorrectly or strips them, producing schema-valid but semantically wrong tool calls.

- [vllm#41240](https://github.com/vllm-project/vllm/issues/41240) (fixed upstream 2026-05-06)

---

## Layer 3: Performance / Safety / Cost Issues

### 24. Default Thinking Mode Wastes Budget

Both V4-Pro and V4-Flash default to `thinking=enabled`. Even trivial prompts ("OK", "hi") burn 30-300 reasoning tokens for no benefit. Adds latency and cost.

**Fix:** Explicitly disable thinking for non-reasoning tasks:
```python
extra_body={"thinking": {"type": "disabled"}}
```

---

### 25. Thinking Mode Silences temperature/top_p/presence_penalty/frequency_penalty

When thinking mode is enabled, these sampling parameters are silently ignored. The API returns no error — the parameters just have zero effect. Teams may be tuning them thinking they work.

- [laravel/ai#533](https://github.com/laravel/ai/issues/533)
- [DeepSeek Thinking Mode docs](https://api-docs.deepseek.com/guides/thinking_mode)

**Fix:** Only control thinking behavior via the thinking toggle, `reasoning_effort` (`high`/`max`), and prompt design. Remove temperature/penalty tuning when thinking is on.

---

### 26. V8 String Limit Crash (Reasoning Runaway)

Without an explicit `max_tokens`, the model can stream 8,000+ reasoning chunks (26 KB, 84 seconds on an adversarial self-doubt prompt). Electron-based clients (ChatWise, Cherry Studio) crash with `RangeError: Invalid string length` when their string buffer hits the V8 ~512 MB ceiling.

**Fix:** Always set `max_tokens`.

---

### 27. 1-3 Character SSE Chunks (Performance)

Reasoning content streams in 1-3 character SSE chunks. Naive string concatenation (`state += chunk`) creates O(n²) allocation cost.

**Fix:** Use list buffer + `"".join(list)`.

---

### 28. Model ID / Provider Name Mismatch in SDKs

Frameworks that haven't updated their model-ID mapping to include `deepseek-v4-pro` / `deepseek-v4-flash` fall through to default provider profiles, which may:
- Fail to suppress `tool_choice` (causing 400s)
- Not preserve `reasoning_content` through multi-turn loops
- Break structured output

- [pydantic-ai#5193](https://github.com/pydantic/pydantic-ai/issues/5193): `DeepSeekProvider` only recognized `deepseek-chat` and `deepseek-reasoner`, not V4 IDs
- [langchainjs#10954](https://github.com/langchain-ai/langchainjs/issues/10954): V4 falls back to reasoning mode and breaks structured output via `@langchain/deepseek`
- 128 parallel tool calls supported ([DEV article](https://dev.to/rupa_tiwari_dd308948d710f/connect-your-mcp-server-with-deepseek-v4-step-by-step-guide-2026-5dop))

**Fix:** Explicitly set `model="deepseek-v4-pro"` when calling the API. Verify framework has updated model mappings.

---

## Summary: Three Layers of Issues

| Layer | What goes wrong | Who hits it |
|---|---|---|
| **Protocol** (API contract) | reasoning_content 400, tool_choice rejection, /beta remap, streaming interleave, empty chunks, DSML leaking, structured output corruption | Everyone using DeepSeek V4 with tools |
| **Schema** (argument format) | null-vs-omit, string-vs-array, empty objects, bool-as-string, JSON bracket loss, parameter hallucination, invalid JSON, truncation | Agents with strict validation (Zod, Pydantic) |
| **Performance** (cost/safety) | default thinking, silenced sampling params, runaway reasoning, V8 crash, O(n²) buffering, model-ID mismatches | Heavy users, long sessions, Electron clients |

**Top 3 by blast radius:**
1. **reasoning_content lifecycle 400** — breaks multi-turn tool loops in every framework
2. **`tool_choice="required"` rejection** — breaks structured output in LangChain/AutoGen/CrewAI/pydantic-ai
3. **Default thinking mode** — wastes budget, silences sampling params, and causes the above two issues

---

## Quick Reference: Fixes by Framework / Use Case

| Use case | What to do |
|---|---|
| Multi-turn tool calling | Preserve `reasoning_content` on every assistant message with tool_calls |
| Structured output (LangChain etc.) | Disable thinking OR suppress `tool_choice` OR route through `/anthropic` endpoint |
| Force a specific tool call | Use `/anthropic` endpoint with `tool_choice={"type":"any"}` or disable thinking |
| JSON mode | Disable thinking; include "json" in prompt; check `finish_reason` |
| Streaming | Aggregate parallel tool calls by `tc.index`; tolerate empty chunks; use `"".join(list)` |
| Strict mode | Use `/beta` URL (but then tool_choice is broken — test carefully) |
| Budget-sensitive | Disable thinking; set `max_tokens`; maximize prefix cache hits |
| Self-hosted vLLM | Disable thinking for JSON mode; avoid streaming with auto tool_choice for now |

---

## TODO: Further Research

- [ ] Test each issue on `deepseek-v4-pro` vs `deepseek-v4-flash` separately (note: deepseek-harness found protocols are bit-for-bit identical)
- [ ] Verify which issues also affect self-hosted vLLM / SGLang deployments
- [ ] Check regression status on next model release
- [ ] Test OpenRouter and other relay endpoints for same patterns
- [ ] Add reproduction commands for each issue
- [ ] Classify deterministically repairable vs. requires model fix
- [ ] Test `/anthropic` endpoint as workaround path for forced tool calls
