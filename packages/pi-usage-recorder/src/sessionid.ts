/** A sortable, human-readable session id: "<iso-to-seconds>-<rand4>".
 *  e.g. 2026-06-13T14-22-05-3f9c  (sorts chronologically as a string). */
export function newSessionId(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, "-"); // 2026-06-13T14-22-05
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${stamp}-${rand}`;
}
