/** Cheap secret scan for ingest — block obvious keys/tokens from entering the library. */
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "ssh-private", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "generic-token", re: /\b(token|secret|password)\b\s*[:=]\s*\S{12,}/i },
];
export function scanSecrets(text: string): string[] {
  return PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}
