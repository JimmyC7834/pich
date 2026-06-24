<script lang="ts">
  import { onState, ready, persistUi, initialUi } from "./lib/bridge";
  import type { HubState } from "./lib/types";
  import TabBar from "./TabBar.svelte";
  import LibraryTab from "./tabs/LibraryTab.svelte";
  import SkillsTab from "./tabs/SkillsTab.svelte";
  import ToolsTab from "./tabs/ToolsTab.svelte";
  import LoadoutTab from "./tabs/LoadoutTab.svelte";
  import RalphTab from "./tabs/RalphTab.svelte";

  let hub: HubState | null = $state(null);
  onState((s) => (hub = s));
  ready();

  const TABS = [
    { id: "library", label: "Library", icon: "📚" },
    { id: "skills", label: "Skills", icon: "⚡" },
    { id: "tools", label: "Tools", icon: "🛠" },
    { id: "loadouts", label: "Loadouts", icon: "📦" },
    { id: "ralph", label: "Ralph", icon: "📋" },
  ];

  let order: string[] = $state(initialUi.tabOrder ?? TABS.map((t) => t.id));
  let active: string = $state(initialUi.activeTab ?? "library");

  function select(id: string) { active = id; save(); }
  function reorder(o: string[]) { order = o; save(); }
  function save() { persistUi({ tabOrder: order, activeTab: active }); }
</script>

<TabBar tabs={TABS} {active} {order}
  onSelect={select}
  onReorder={reorder} />
<main>
  {#if !hub}<p style="padding:10px">Connecting…</p>
  {:else}
    {#if active === "library"}<LibraryTab state={hub} />{/if}
    {#if active === "skills"}<SkillsTab state={hub} />{/if}
    {#if active === "tools"}<ToolsTab state={hub} />{/if}
    {#if active === "loadouts"}<LoadoutTab state={hub} />{/if}
    {#if active === "ralph"}<RalphTab state={hub} />{/if}
  {/if}
</main>
<footer>{hub?.connected ? "● connected" : "○ offline"} · active loadout: {hub?.activeLoadout ?? "—"}</footer>
<style>
  main{padding:10px;overflow:auto}
  footer{position:sticky;bottom:0;padding:4px 10px;border-top:1px solid var(--vscode-panel-border);font-size:.85em;opacity:.8;background:var(--vscode-editor-background)}
</style>
