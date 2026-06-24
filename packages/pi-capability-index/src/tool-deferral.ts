export interface DeferralInput {
  allToolNames: string[];        // pi.getAllTools().map(t => t.name)
  deferrableNames: Set<string>;  // indexed tool capabilities, as bare tool names
  keepNames: Set<string>;        // bare tool names to keep active (loadout ∪ session ∪ promoted)
}

/** Tool names that should remain active when deferral is enabled. */
export function computeActiveToolNames(input: DeferralInput): string[] {
  return input.allToolNames.filter(
    (n) => !input.deferrableNames.has(n) || input.keepNames.has(n),
  );
}
