---
description: Remind to preserve `reasoning_content` in multi-turn tool calls with DeepSeek V4
condition:
  - "reasoning_content"
  - "400.*reasoning_content"
  - "must be passed back"
scope: "tool:bash"
interruptMode: never
---

DeepSeek V4 requires that `reasoning_content` from the assistant's previous response be passed back verbatim in the next request when making multi-turn tool calls. If you strip or omit it, the API returns a 400 error ("reasoning_content must be passed back in subsequent requests"). Preserve the `reasoning_content` field from the prior response when constructing the next request.