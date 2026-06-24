<script lang="ts">let { on = false }: { on?: boolean } = $props();</script>
<span class="dot" class:on></span>
<style>.dot{width:7px;height:7px;border-radius:50%;display:inline-block;border:1px solid var(--vscode-descriptionForeground)}
.dot.on{background:var(--vscode-charts-green,#89d185);border-color:var(--vscode-charts-green,#89d185)}</style>
