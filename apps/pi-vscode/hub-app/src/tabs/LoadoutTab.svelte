<script lang="ts">
  import type { HubState, Loadout } from "../lib/types";
  import { post } from "../lib/bridge";
  let { state: hub }: { state: HubState } = $props();
  let open = $state<string | null>(null);
  let editing = $state(false);
  function toggle(n: string) { if (open === n) { open = null; } else { open = n; editing = false; } }
  function activate(n: string) { post({ type: "activateLoadout", name: n }); }
  function create() {
    const name = prompt("New loadout name:")?.trim(); if (!name) return;
    post({ type: "createLoadout", data: { name } }); open = name; editing = false;
  }
  function duplicate(l: Loadout) {
    const name = prompt("Duplicate as:", l.name + "-copy")?.trim(); if (!name) return;
    post({ type: "createLoadout", data: { name, description: l.description, skills: l.skills, tools: l.tools } });
  }
  function del(n: string) { if (confirm(`Delete loadout "${n}"?`)) { post({ type: "deleteLoadout", name: n }); open = null; } }
  function toggleSkill(l: Loadout, capId: string) {
    const skills = l.skills.includes(capId) ? l.skills.filter((x) => x !== capId) : [...l.skills, capId];
    post({ type: "updateLoadout", data: { name: l.name, skills, tools: l.tools } });
  }
</script>
<div class="hd">Active: <strong>{hub.activeLoadout ?? "—"}</strong>
  <span class="sp"></span><button onclick={create}>➕ New Loadout</button></div>
<ul class="list">
  {#each hub.loadouts as l (l.name)}
    <li class:sel={l.name === open}>
      <button class="pick" onclick={() => toggle(l.name)}>
        <span class="tw">{open === l.name ? "▾" : "▸"}</span>
        {l.name === hub.activeLoadout ? "●" : "○"} {l.name}
        <span class="ct">{l.skills.length} skills</span>
      </button>
      <button onclick={() => activate(l.name)}>Activate</button>
      <button onclick={() => duplicate(l)}>Duplicate</button>
      <button onclick={() => del(l.name)}>Delete</button>
    </li>
    {#if open === l.name}
      <div class="members">
        <div class="mh">Skills in "{l.name}"<span class="sp"></span>
          <button onclick={() => (editing = !editing)}>{editing ? "Done" : "Edit"}</button></div>
        {#if editing}
          {#each hub.skills as s (s.name)}
            {@const cap = "skill:" + s.name}
            <label class="opt"><input type="checkbox" checked={l.skills.includes(cap)}
              onchange={() => toggleSkill(l, cap)} /> {s.name}</label>
          {/each}
        {:else}
          {#each l.skills as cap (cap)}<span class="chip">{cap.replace(/^skill:/, "")}</span>{/each}
          {#if !l.skills.length}<em>none</em>{/if}
        {/if}
      </div>
    {/if}
  {/each}
</ul>
<style>
  .hd,.mh{display:flex;gap:6px;align-items:center;padding:6px 0} .sp{flex:1}
  .list{list-style:none;margin:0;padding:0}
  .list li{display:flex;gap:6px;align-items:center;padding:2px 0} .list li.sel{background:var(--vscode-list-activeSelectionBackground)}
  .pick{flex:1;text-align:left;background:transparent;color:var(--vscode-foreground)} .ct{opacity:.6;font-size:.85em;margin-left:6px}
  .tw{opacity:.6} .members{border-top:1px solid var(--vscode-panel-border);margin:0 0 8px;padding:6px 0 6px 14px}
  .opt{display:block;padding:2px 0} .chip{display:inline-block;border:1px solid var(--vscode-panel-border);border-radius:3px;padding:0 6px;margin:2px}
</style>
