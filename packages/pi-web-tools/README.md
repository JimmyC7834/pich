# @jc4649/pi-web-tools

Web search, URL fetching, GitHub cloning, and PDF/YouTube/video extraction for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Provides `web_search`, `fetch_content`, `get_search_content`, and `code_search`. Zero-config with an Exa MCP fallback; optional API keys in `~/.pi/web-search.json` for Perplexity, Gemini, or Exa. Extracts URLs (readability + Gemini fallback), GitHub repos, YouTube transcripts (with frames), PDFs, and local video files.

## Fork notice

Slimmed fork of [**pi-web-access**](https://github.com/nicobailon/pi-web-access) by **Nico Bailon** (MIT). Changes:

- `node-html-markdown` instead of the heavier HTML-to-markdown stack (−8.7 MB)
- magic-byte image sniffing in place of the `file-type` dependency
- trimmed packaging to source + skills only

All credit for the original design and the bulk of the implementation goes to Nico Bailon.

## Install

```
pi install @jc4649/pi-web-tools
```

Part of the [pich harness](https://github.com/JimmyC7834/pich).

## License

MIT — © Nico Bailon (original), © 2026 jc4649. See [LICENSE](./LICENSE).
