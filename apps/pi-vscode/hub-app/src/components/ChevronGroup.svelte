<script lang="ts">
  let { id, title, count = "", collapsed = false, onToggle, children }:
    { id: string; title: string; count?: string | number; collapsed?: boolean; onToggle: (id: string) => void; children: any } = $props();
</script>
<div class="group" class:collapsed>
  <button class="head" onclick={() => onToggle(id)}>
    <span class="chev">▾</span><span>{title}</span><span class="count">{count}</span>
  </button>
  {#if !collapsed}<div class="body">{@render children()}</div>{/if}
</div>
<style>
  .group .head{display:flex;gap:4px;width:100%;align-items:center;background:transparent;color:var(--vscode-sideBarSectionHeader-foreground);text-transform:uppercase;font-size:11px;font-weight:600;padding:4px 8px}
  .group .head:hover{background:var(--vscode-list-hoverBackground)}
  .count{margin-left:auto;opacity:.7;font-weight:400}
  .chev{transition:transform .12s} .collapsed .chev{transform:rotate(-90deg)}
</style>
