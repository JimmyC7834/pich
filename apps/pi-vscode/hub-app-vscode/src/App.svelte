<script lang="ts">
  import { onState, ready } from "./lib/bridge";
  import type { HubState } from "./lib/types";
  import LibraryTab from "./tabs/LibraryTab.svelte";
  import SkillsTab from "./tabs/SkillsTab.svelte";
  import ToolsTab from "./tabs/ToolsTab.svelte";
  import LoadoutTab from "./tabs/LoadoutTab.svelte";
  import RalphTab from "./tabs/RalphTab.svelte";

  let hub = $state<HubState | null>(null);
  onState((s) => (hub = s));
  ready();
</script>

{#if !hub}
  <p style="padding:8px">Connecting…</p>
{:else}
  <vscode-tabs>
    <vscode-tab-header slot="header">Library</vscode-tab-header>
    <vscode-tab-panel><LibraryTab {hub} /></vscode-tab-panel>
    <vscode-tab-header slot="header">Skills</vscode-tab-header>
    <vscode-tab-panel><SkillsTab {hub} /></vscode-tab-panel>
    <vscode-tab-header slot="header">Tools</vscode-tab-header>
    <vscode-tab-panel><ToolsTab {hub} /></vscode-tab-panel>
    <vscode-tab-header slot="header">Loadouts</vscode-tab-header>
    <vscode-tab-panel><LoadoutTab {hub} /></vscode-tab-panel>
    <vscode-tab-header slot="header">Ralph</vscode-tab-header>
    <vscode-tab-panel><RalphTab {hub} /></vscode-tab-panel>
  </vscode-tabs>
{/if}

<footer>
  <vscode-badge>{hub?.connected ? "● connected" : "○ offline"}</vscode-badge>
  <span>active loadout: {hub?.activeLoadout ?? "—"}</span>
</footer>
