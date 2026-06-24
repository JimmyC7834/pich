const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/,                 // OpenAI-style
  /AKIA[0-9A-Z]{16}/,                    // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,  // PEM private key
  /ghp_[A-Za-z0-9]{30,}/,                // GitHub PAT
];
export function findSecret(text: string): boolean { return PATTERNS.some((p) => p.test(text)); }
