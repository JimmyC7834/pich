<script lang="ts">
  import type { HubState, SkillEntry } from "../lib/types";
  import { post } from "../lib/bridge";
  let { hub }: { hub: HubState } = $props();

  let q = $state("");
  let open = $state<string | null>(null);

  const activeSet = $derived(new Set(
    (hub.loadouts.find((l) => l.name === hub.activeLoadout)?.skills ?? []).map((id) => id.replace(/^skill:/, "")),
  ));
  function inLoadout(s: SkillEntry) { return activeSet.has(s.name) || s.isActive; }
  function hit(s: SkillEntry) { return !q || (s.name + " " + s.description).toLowerCase().includes(q); }
  function dir(p: string) { return p.replace(/[\\/][^\\/]*$/, ""); }
  function toggle(s: SkillEntry) {
    if (open === s.name) { open = null; return; }
    open = s.name;
    if (s.filePath) post({ type: "readFile", path: s.filePath });
  }
  const shown = $derived(hub.skills.filter(hit));
</script>

<vscode-textfield placeholder="Search skills…" style="width:100%"
  oninput={(e: any) => (q = e.target.value.toLowerCase())}></vscode-textfield>
<div class="count">{shown.length}/{hub.skills.length}</div>

{#each shown as s (s.name)}
  <div class="row" class:open={open === s.name} role="button" tabindex="0"
    onclick={() => toggle(s)} onkeydown={(e: any) => e.key === "Enter" && toggle(s)}>
    <span class="tw">{open === s.name ? "▾" : "▸"}</span>
    <span class="dot" class:on={inLoadout(s)}></span>
    <span class="nm">{s.name}</span><span class="ds">{s.description}</span>
  </div>
  {#if open === s.name}
    <div class="preview">
      <div class="hd">
        <span class="sp"></span>
        {#if s.filePath}
          <vscode-button secondary onclick={() => post({ type: "revealDir", path: dir(s.filePath) })}>Open Dir</vscode-button>
        {/if}
      </div>
      <pre>{hub.docContents[s.filePath] ?? "Loading…"}</pre>
    </div>
  {/if}
{/each}
