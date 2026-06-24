---
description: Remind that `tool_choice="required"` fails in DeepSeek V4 thinking mode
condition:
  - "tool_choice.*required"
  - "tool_choice.*function.*name"
  - "force.*tool"
scope: "tool:bash"
interruptMode: never
---

DeepSeek V4's thinking mode does not support `tool_choice="required"` — the API silently ignores it or errors. Use `tool_choice: "auto"` (or omit `tool_choice` entirely) when calling DeepSeek V4 models in thinking mode. If you must force a tool call, use a two-step flow: let the model respond first, then extract the tool call from its output.