<script lang="ts">
  import type { HubState, KBDocEntry } from "../lib/types";
  import { post } from "../lib/bridge";
  import SearchBar from "../components/SearchBar.svelte";
  import ChevronGroup from "../components/ChevronGroup.svelte";
  import DocPreview from "./DocPreview.svelte";
  let { state: hub }: { state: HubState } = $props();
  let q = $state("");
  let sel = $state<KBDocEntry | null>(null);
  let collapsed = $state<Record<string, boolean>>({});
  function hit(d: KBDocEntry) {
    if (!q) return true;
    return (d.title + " " + (d.tags ?? []).join(" ")).toLowerCase().includes(q);
  }
  function pick(d: KBDocEntry) { sel = d; post({ type: "readFile", path: d.filePath }); }
  let total = $derived(hub.collections.reduce((n, c) => n + c.docs.filter(hit).length, 0));
</script>
<SearchBar placeholder="Search KB docs…" onSearch={(t) => (q = t)} />
<div class="count">{total} docs</div>
{#each hub.collections as c (c.name)}
  {@const docs = c.docs.filter(hit)}
  {#if docs.length || !q}
    <ChevronGroup id={c.name} title={"📁 " + c.name} count={docs.length}
      collapsed={collapsed[c.name]} onToggle={(id) => (collapsed[id] = !collapsed[id])}>
      {#snippet children()}
        {#each docs as d (d.id)}
          <button class="row" onclick={() => pick(d)}>
            📄 {d.title} <span class="tags">{(d.tags ?? []).join(", ")}</span>
          </button>
        {/each}
      {/snippet}
    </ChevronGroup>
  {/if}
{/each}
{#if sel}
  <DocPreview title={sel.title} path={sel.filePath}
    content={hub.docContents[sel.filePath]}
    onOpen={(p) => post({ type: "openInEditor", path: p })} />
{/if}
<style>
  .count{padding:2px 8px;opacity:.7;font-size:.85em}
  .row{display:flex;gap:6px;width:100%;background:transparent;color:var(--vscode-foreground);padding:3px 8px 3px 22px}
  .row:hover{background:var(--vscode-list-hoverBackground)}
  .tags{opacity:.6;font-size:.85em}
</style>
