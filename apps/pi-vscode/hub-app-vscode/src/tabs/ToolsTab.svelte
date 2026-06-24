<script lang="ts">
  import type { HubState, ToolEntry } from "../lib/types";
  import { post } from "../lib/bridge";
  let { hub }: { hub: HubState } = $props();

  let q = $state("");
  let activeOnly = $state(false);
  let open = $state<string | null>(null);

  function hit(t: ToolEntry) {
    if (activeOnly && !t.isActive) return false;
    return !q || (t.name + " " + t.description).toLowerCase().includes(q);
  }
  function toggle(t: ToolEntry) { open = open === t.name ? null : t.name; }
  const shown = $derived(hub.tools.filter(hit));
</script>

<div class="bar">
  <vscode-textfield placeholder="Filter tools…" style="flex:1"
    oninput={(e: any) => (q = e.target.value.toLowerCase())}></vscode-textfield>
  <vscode-checkbox onchange={(e: any) => (activeOnly = e.target.checked)}>Active only</vscode-checkbox>
</div>

{#each shown as t (t.name)}
  <div class="row" class:on={t.isActive} class:open={open === t.name} role="button" tabindex="0"
    onclick={() => toggle(t)} onkeydown={(e: any) => e.key === "Enter" && toggle(t)}>
    <span class="tw">{open === t.name ? "▾" : "▸"}</span>
    <span class="ck">{t.isActive ? "✓" : "○"}</span>
    <span class="nm">{t.name}</span><span class="ds">{t.description}</span>
    <vscode-badge>{t.source}</vscode-badge>
  </div>
  {#if open === t.name}
    <div class="preview">
      <p>{t.description}</p>
      <div>Source: <vscode-badge>{t.source}</vscode-badge></div>
      <pre>{JSON.stringify(t.schema ?? {}, null, 2)}</pre>
      <vscode-button onclick={() => post({ type: "toggleTool", name: t.name, active: !t.isActive })}>
        {t.isActive ? "Toggle Off" : "Toggle On"}
      </vscode-button>
    </div>
  {/if}
{/each}
