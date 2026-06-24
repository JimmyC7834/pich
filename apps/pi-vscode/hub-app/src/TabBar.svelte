<script lang="ts">
  let { tabs, active, order, onSelect, onReorder }:
    { tabs: { id: string; label: string; icon: string }[]; active: string; order: string[];
      onSelect: (id: string) => void; onReorder: (o: string[]) => void } = $props();
  let dragId: string | null = null;
  const ordered = $derived(order.map((id) => tabs.find((t) => t.id === id)!).filter(Boolean));
  function ondrop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const next = [...order];
    next.splice(next.indexOf(dragId), 1);
    next.splice(next.indexOf(targetId), 0, dragId);
    dragId = null; onReorder(next);
  }
</script>
<nav class="tabbar">
  {#each ordered as t (t.id)}
    <button class="tab" class:active={t.id === active} draggable="true"
      onclick={() => onSelect(t.id)}
      ondragstart={() => (dragId = t.id)}
      ondragover={(e) => e.preventDefault()}
      ondrop={() => ondrop(t.id)}>
      {t.icon} {t.label}
    </button>
  {/each}
</nav>
<style>
  .tabbar{display:flex;gap:2px;border-bottom:1px solid var(--vscode-panel-border)}
  .tab{background:transparent;color:var(--vscode-foreground);border-radius:0;padding:6px 12px;opacity:.75}
  .tab.active{opacity:1;background:var(--vscode-tab-activeBackground);border-bottom:2px solid var(--vscode-focusBorder)}
</style>
