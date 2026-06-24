<script lang="ts">
  import type { HubState, KBDocEntry } from "../lib/types";
  import { post } from "../lib/bridge";
  let { hub }: { hub: HubState } = $props();

  let q = $state("");
  let sel = $state<KBDocEntry | null>(null);
  let treeEl = $state<any>(null);

  function hit(d: KBDocEntry) {
    return !q || (d.title + " " + (d.tags ?? []).join(" ")).toLowerCase().includes(q);
  }
  const docByPath = $derived(
    new Map(hub.collections.flatMap((c) => c.docs.map((d) => [d.filePath, d] as const))),
  );
  const treeData = $derived(
    hub.collections
      .map((c) => ({
        label: c.name,
        open: true,
        icons: { branch: "folder", open: "folder-opened", leaf: "file" },
        subItems: c.docs.filter(hit).map((d) => ({ label: d.title, value: d.filePath, icons: { leaf: "file" } })),
      }))
      .filter((n) => n.subItems.length || !q),
  );
  const total = $derived(treeData.reduce((n, c) => n + c.subItems.length, 0));

  function pick(d: KBDocEntry) { sel = d; post({ type: "readFile", path: d.filePath }); }
  function onSelect(e: any) {
    const v = e?.detail?.value;
    const d = v ? docByPath.get(v) : undefined;
    if (d) pick(d);
  }

  // vscode-tree takes its rows via the `.data` property (not an attribute).
  $effect(() => { if (treeEl) treeEl.data = treeData; });
  $effect(() => {
    if (!treeEl) return;
    treeEl.addEventListener("vsc-tree-select", onSelect);
    return () => treeEl.removeEventListener("vsc-tree-select", onSelect);
  });
</script>

<vscode-textfield placeholder="Search KB docs…" style="width:100%"
  oninput={(e: any) => (q = e.target.value.toLowerCase())}></vscode-textfield>
<div class="count">{total} docs</div>
<vscode-tree bind:this={treeEl} indent-guides arrows></vscode-tree>

{#if sel}
  <div class="preview">
    <div class="hd">
      <strong>{sel.title}</strong><span class="sp"></span>
      <vscode-button onclick={() => post({ type: "openInEditor", path: sel!.filePath })}>Open in Editor</vscode-button>
      <vscode-button secondary onclick={() => navigator.clipboard.writeText(sel!.filePath)}>Copy Doc ID</vscode-button>
    </div>
    <pre>{hub.docContents[sel.filePath] ?? "Loading…"}</pre>
  </div>
{/if}
