---
description: Block writing obvious secrets or private keys into files
condition:
  - "AKIA[0-9A-Z]{16}"
  - "-----BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----"
  - "xox[baprs]-[0-9A-Za-z]{10,}"
scope: "tool:write, tool:edit"
interruptMode: always
---

Do not write secrets, API keys, or private keys into source or config files. Load them from an environment variable or an untracked local file at runtime instead. Committing a credential — even briefly — leaks it.
