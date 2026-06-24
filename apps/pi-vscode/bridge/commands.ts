import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Register hidden commands that proxy ExtensionCommandContext-only APIs
 * (fork, resume/session-switch) so the WS server can trigger them.
 */
export function registerProxyCommands(pi: ExtensionAPI): void {
  pi.registerCommand("pi-bridge-fork", {
    description: "[internal] Fork session from an entry",
    handler: async (args, ctx) => {
      const { entryId } = JSON.parse(args) as { entryId: string };
      await ctx.fork(entryId);
    },
  });

  pi.registerCommand("pi-bridge-resume", {
    description: "[internal] Resume a saved session",
    handler: async (args, ctx) => {
      const { sessionFile } = JSON.parse(args) as { sessionFile: string };
      await ctx.switchSession(sessionFile);
    },
  });
}
