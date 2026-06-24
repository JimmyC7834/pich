<script lang="ts">
  import type { HubState, ToolEntry } from "../lib/types";
  import { post } from "../lib/bridge";
  import SearchBar from "../components/SearchBar.svelte";
  import Badge from "../components/Badge.svelte";
  let { state: hub }: { state: HubState } = $props();
  let q = $state(""); let activeOnly = $state(false); let open = $state<string | null>(null);
  function hit(t: ToolEntry) {
    if (activeOnly && !t.isActive) return false;
    return !q || (t.name + " " + t.description).toLowerCase().includes(q);
  }
  function toggle(t: ToolEntry) { open = open === t.name ? null : t.name; }
  const shown = $derived(hub.tools.filter(hit));
</script>
<div class="bar">
  <SearchBar placeholder="Filter tools…" onSearch={(t) => (q = t)} />
  <label><input type="checkbox" checked={activeOnly} onchange={(e) => (activeOnly = (e.target as HTMLInputElement).checked)} /> Active only</label>
</div>
{#each shown as t (t.name)}
  <button class="row" class:on={t.isActive} class:open={open === t.name} onclick={() => toggle(t)}>
    <span class="tw">{open === t.name ? "▾" : "▸"}</span>
    <span class="ck">{t.isActive ? "✓" : "○"}</span>
    <span class="nm">{t.name}</span><span class="ds">{t.description}</span>
    <Badge text={t.source} />
  </button>
  {#if open === t.name}
    <div class="preview">
      <p>{t.description}</p>
      <div>Source: <Badge text={t.source} /></div>
      <pre>{JSON.stringify(t.schema ?? {}, null, 2)}</pre>
      <button onclick={() => post({ type: "toggleTool", name: t.name, active: !t.isActive })}>
        {t.isActive ? "Toggle Off" : "Toggle On"}
      </button>
    </div>
  {/if}
{/each}
<style>
  .bar{display:flex;gap:8px;align-items:center;padding:4px 0} label{font-size:.85em;white-space:nowrap}
  .row{display:flex;gap:6px;width:100%;align-items:center;background:transparent;color:var(--vscode-foreground);padding:3px 8px;opacity:.7}
  .row.on{opacity:1} .row:hover{background:var(--vscode-list-hoverBackground)} .row.open{background:var(--vscode-list-activeSelectionBackground)}
  .tw{opacity:.6;width:1em}
  .ds{flex:1;opacity:.6;font-size:.9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .preview{border:1px solid var(--vscode-panel-border);border-radius:4px;margin:0 8px 8px;padding:8px}
  pre{max-height:30vh;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:6px;border-radius:3px}
</style>
