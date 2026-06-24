<script lang="ts">
  import type { HubState, RalphProject, RalphTask } from "../lib/types";
  import SearchBar from "../components/SearchBar.svelte";
  let { state: hub }: { state: HubState } = $props();
  const COLS: { key: "todo" | "doing" | "done"; label: string }[] = [
    { key: "todo", label: "TODO" },
    { key: "doing", label: "DOING" },
    { key: "done", label: "DONE" },
  ];
  const count = (p: RalphProject) => p.todo.length + p.doing.length + p.done.length;
  let q = $state("");
  const shown = $derived(hub.ralph.filter((p) => !q || p.name.toLowerCase().includes(q)));
</script>

{#if hub.ralph.length === 0}
  <p class="empty">No Ralph tasks. Add some with <code>/ralph-add</code>.</p>
{:else}
  <SearchBar placeholder="Filter projects…" onSearch={(t) => (q = t)} />
  {#each shown as p (p.id)}
    <details class="proj">
      <summary>{p.name} <span class="n">{p.done.length}/{count(p)} done</span></summary>
      <div class="cols">
        {#each COLS as c (c.key)}
          <div class="col">
            <div class="head">{c.label} <span class="n">{(p[c.key] as RalphTask[]).length}</span></div>
            {#each p[c.key] as RalphTask[] as t (t.id)}
              <div class="card" class:done={c.key === "done"} title={t.id}>
                <span class="pr">p{t.priority}</span>{t.title}
              </div>
            {/each}
            {#if (p[c.key] as RalphTask[]).length === 0}<div class="none">—</div>{/if}
          </div>
        {/each}
      </div>
    </details>
  {/each}
{/if}

<style>
  .empty{padding:10px;opacity:.7} code{background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px}
  .proj{margin-bottom:10px}
  summary{cursor:pointer;font-size:1em;font-weight:600;padding:4px 2px;display:flex;align-items:center;gap:8px;user-select:none}
  summary:hover{background:var(--vscode-list-hoverBackground)}
  .proj[open] summary{margin-bottom:6px}
  .cols{padding-left:14px}
  .n{font-size:.8em;opacity:.6;font-weight:normal}
  .cols{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  .col{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:6px;min-width:0}
  .head{font-size:.78em;letter-spacing:.04em;opacity:.7;margin-bottom:6px;display:flex;justify-content:space-between}
  .card{background:var(--vscode-list-hoverBackground);border-radius:3px;padding:4px 6px;margin-bottom:4px;font-size:.85em;overflow:hidden;text-overflow:ellipsis}
  .card.done{opacity:.6;text-decoration:line-through}
  .pr{font-size:.75em;opacity:.6;margin-right:5px}
  .none{opacity:.35;text-align:center;font-size:.85em}
</style>
