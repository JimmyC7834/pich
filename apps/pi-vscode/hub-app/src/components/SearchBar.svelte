<script lang="ts">
  let { value = "", placeholder = "Search…", onSearch }: { value?: string; placeholder?: string; onSearch: (t: string) => void } = $props();
  let t: ReturnType<typeof setTimeout>;
  function oninput(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    clearTimeout(t); t = setTimeout(() => onSearch(v.toLowerCase()), 150);
  }
</script>
<input type="text" {placeholder} {value} {oninput} style="width:100%" />
