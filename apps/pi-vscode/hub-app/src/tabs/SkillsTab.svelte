<script lang="ts">
  import type { HubState, SkillEntry } from "../lib/types";
  import { post } from "../lib/bridge";
  import SearchBar from "../components/SearchBar.svelte";
  import Dot from "../components/Dot.svelte";
  let { state: hub }: { state: HubState } = $props();
  let q = $state("");
  let open = $state<string | null>(null);
  const activeSet = $derived(new Set(
    (hub.loadouts.find((l) => l.name === hub.activeLoadout)?.skills ?? []).map((id) => id.replace(/^skill:/, "")),
  ));
  function inLoadout(s: SkillEntry) { return activeSet.has(s.name) || s.isActive; }
  function hit(s: SkillEntry) { return !q || (s.name + " " + s.description).toLowerCase().includes(q); }
  function toggle(s: SkillEntry) {
    if (open === s.name) { open = null; return; }
    open = s.name;
    if (s.filePath) post({ type: "readFile", path: s.filePath });
  }
  function dir(p: string) { return p.replace(/[\\/][^\\/]*$/, ""); }
  const shown = $derived(hub.skills.filter(hit));
</script>
<SearchBar placeholder="Search skills…" onSearch={(t) => (q = t)} />
<div class="count">{shown.length}/{hub.skills.length}</div>
{#each shown as s (s.name)}
  <button class="row" class:open={open === s.name} onclick={() => toggle(s)}>
    <span class="tw">{open === s.name ? "▾" : "▸"}</span>
    <Dot on={inLoadout(s)} /> <span class="nm">{s.name}</span>
    <span class="ds">{s.description}</span>
  </button>
  {#if open === s.name}
    <div class="preview">
      <div class="hd"><span class="sp"></span>
        {#if s.filePath}<button onclick={() => post({ type: "revealDir", path: dir(s.filePath) })}>📂 Open Dir</button>{/if}
      </div>
      <pre>{hub.docContents[s.filePath] ?? "Loading…"}</pre>
    </div>
  {/if}
{/each}
<style>
  .count{padding:2px 8px;opacity:.7;font-size:.85em}
  .row{display:flex;gap:6px;width:100%;align-items:center;background:transparent;color:var(--vscode-foreground);padding:3px 8px}
  .row:hover{background:var(--vscode-list-hoverBackground)} .row.open{background:var(--vscode-list-activeSelectionBackground)}
  .tw{opacity:.6;width:1em} .ds{opacity:.6;font-size:.9em}
  .preview{border:1px solid var(--vscode-panel-border);border-radius:4px;margin:0 8px 8px}
  .hd{display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border)}
  .sp{flex:1} pre{margin:0;padding:8px;max-height:40vh;overflow:auto;white-space:pre-wrap}
</style>
