<script lang="ts">
  import type { HubState, Loadout } from "../lib/types";
  import { post } from "../lib/bridge";
  let { hub }: { hub: HubState } = $props();

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

<div class="hd">
  Active: <strong>{hub.activeLoadout ?? "—"}</strong><span class="sp"></span>
  <vscode-button onclick={create}>New Loadout</vscode-button>
</div>
<vscode-divider></vscode-divider>

{#each hub.loadouts as l (l.name)}
  <div class="lrow" class:open={l.name === open}>
    <span class="pick nm" role="button" tabindex="0"
      onclick={() => toggle(l.name)} onkeydown={(e: any) => e.key === "Enter" && toggle(l.name)}>
      <span class="tw">{open === l.name ? "▾" : "▸"}</span>
      {l.name === hub.activeLoadout ? "●" : "○"} {l.name}<span class="ct">{l.skills.length} skills</span>
    </span>
    <span class="sp"></span>
    <vscode-button secondary onclick={() => activate(l.name)}>Activate</vscode-button>
    <vscode-button secondary onclick={() => duplicate(l)}>Duplicate</vscode-button>
    <vscode-button secondary onclick={() => del(l.name)}>Delete</vscode-button>
  </div>
  {#if open === l.name}
    <div class="members">
      <div class="mh">
        Skills in "{l.name}"<span class="sp"></span>
        <vscode-button secondary onclick={() => (editing = !editing)}>{editing ? "Done" : "Edit"}</vscode-button>
      </div>
      {#if editing}
        {#each hub.skills as s (s.name)}
          {@const cap = "skill:" + s.name}
          <vscode-checkbox checked={l.skills.includes(cap)} onchange={() => toggleSkill(l, cap)}>{s.name}</vscode-checkbox>
        {/each}
      {:else}
        {#each l.skills as cap (cap)}<vscode-badge>{cap.replace(/^skill:/, "")}</vscode-badge>{/each}
        {#if !l.skills.length}<em>none</em>{/if}
      {/if}
    </div>
  {/if}
{/each}
