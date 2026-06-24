---
description: Remind that DeepSeek V4 defaults to thinking mode, wasting tokens and silencing temperature/penalty params
condition:
  - "deepseek-v4-pro"
  - "deepseek-v4-flash"
  - "deepseek-chat"
  - "deepseek-reasoner"
scope: "tool:bash"
interruptMode: never
---

DeepSeek V4 models (deepseek-v4-pro, deepseek-v4-flash, deepseek-chat, deepseek-reasoner) default to thinking mode. This consumes extra reasoning tokens and disables `temperature`, `top_p`, `presence_penalty`, and `frequency_penalty`. If you want a direct (non-thinking) response, pass `thinking: {type: "enabled", budget_tokens: 0}` or set `no_thinking: true` in the request body. If thinking IS desired, set a reasonable `budget_tokens` to control cost.