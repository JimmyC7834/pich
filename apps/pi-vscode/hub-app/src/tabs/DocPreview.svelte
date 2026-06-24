<script lang="ts">
  let { title, content, path, onOpen }:
    { title: string; content?: string; path: string; onOpen: (p: string) => void } = $props();
</script>
<div class="preview">
  <div class="hd"><strong>{title}</strong>
    <span class="sp"></span>
    <button onclick={() => onOpen(path)}>📂 Open in Editor</button>
    <button onclick={() => navigator.clipboard.writeText(path)}>🔗 Copy Doc ID</button>
  </div>
  <pre>{content ?? "Loading…"}</pre>
</div>
<style>
  .preview{border:1px solid var(--vscode-panel-border);border-radius:4px;margin-top:8px}
  .hd{display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border)}
  .sp{flex:1} pre{margin:0;padding:8px;max-height:40vh;overflow:auto;white-space:pre-wrap}
</style>
