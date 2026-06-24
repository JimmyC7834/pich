---
description: Block `git add -A` / `git add .` — stage paths explicitly
condition:
  - "git\\s+add\\s+-A\\b"
  - "git\\s+add\\s+--all\\b"
  - "git\\s+add\\s+\\.(\\s|$)"
scope: "tool:bash"
interruptMode: always
---

Never stage everything with `git add -A`, `git add --all`, or `git add .`. This repository carries unrelated dirty and untracked files; stage only the exact paths you changed, by name.
