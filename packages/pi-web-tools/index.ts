/**
 * pi-web-tools — stripped-down web access extension
 *
 * Based on pi-web-access (github.com/nicobailon/pi-web-access) but without
 * the browser curator, summary-review workflow, commands, or shortcuts.
 *
 * Tools: web_search | fetch_content | get_search_content | code_search
 * All extraction types: URLs, GitHub, YouTube, PDFs, local video.
 *
 * Zero-config: works with Exa MCP (no API key). Add keys in ~/.pi/web-search.json.
 *
 * Thinking level: all tools accept an optional `thinking` parameter to
 * control the reasoning level for LLM calls used internally (Gemini
 * video analysis, query rewriting). Defaults to off (no thinking).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { fetchAllContent, type ExtractedContent } from "./extract.js";
import { clearCloneCache } from "./github-extract.js";
import { search, type SearchProvider, type ResolvedSearchProvider } from "./gemini-search.js";
import { executeCodeSearch } from "./code-search.js";
import type { SearchResult } from "./perplexity.js";
import {
	clearResults,
	deleteResult,
	generateId,
	getAllResults,
	getResult,
	restoreFromSession,
	storeResult,
	type QueryResultData,
	type StoredSearchData,
} from "./storage.js";
import { activityMonitor, type ActivityEntry } from "./activity.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isPerplexityAvailable } from "./perplexity.js";
import { isExaAvailable } from "./exa.js";
import { isGeminiApiAvailable } from "./gemini-api.js";
import { isGeminiWebAvailable } from "./gemini-web.js";

// ── Config ──────────────────────────────────────────────────────────────────

const WEB_SEARCH_CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface WebSearchConfig {
	provider?: string;
	searchModel?: string;
}

function loadConfig(): WebSearchConfig {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return {};
	try { return JSON.parse(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8")) as WebSearchConfig; }
	catch { return {}; }
}

function normalizeProviderInput(value: unknown): SearchProvider | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return "auto";
	const n = value.trim().toLowerCase();
	if (["auto", "exa", "perplexity", "gemini"].includes(n)) return n as SearchProvider;
	return "auto";
}

function normalizeQueryList(queryList: unknown[]): string[] {
	const out: string[] = [];
	for (const q of queryList) {
		if (typeof q !== "string") continue;
		const t = q.trim();
		if (t.length > 0) out.push(t);
	}
	return out;
}

interface ProviderAvailability {
	perplexity: boolean;
	exa: boolean;
	gemini: boolean;
}

async function getProviderAvailability(): Promise<ProviderAvailability> {
	const geminiWebAvail = await isGeminiWebAvailable();
	return {
		perplexity: isPerplexityAvailable(),
		exa: isExaAvailable(),
		gemini: isGeminiApiAvailable() || !!geminiWebAvail,
	};
}

function resolveProvider(requested: unknown, available: ProviderAvailability): ResolvedSearchProvider {
	const provider = normalizeProviderInput(requested ?? loadConfig().provider ?? "auto") ?? "auto";
	if (provider === "auto") {
		if (available.exa) return "exa";
		if (available.perplexity) return "perplexity";
		if (available.gemini) return "gemini";
		return "exa";
	}
	if (provider === "exa" && !available.exa) return available.perplexity ? "perplexity" : (available.gemini ? "gemini" : "exa");
	if (provider === "perplexity" && !available.perplexity) return available.exa ? "exa" : (available.gemini ? "gemini" : "perplexity");
	if (provider === "gemini" && !available.gemini) return available.exa ? "exa" : (available.perplexity ? "perplexity" : "gemini");
	return provider as ResolvedSearchProvider;
}

// ── Activity & Storage ──────────────────────────────────────────────────────

const pendingFetches = new Map<string, AbortController>();
let sessionActive = false;
let widgetVisible = false;
let widgetUnsubscribe: (() => void) | null = null;

const MAX_INLINE_CONTENT = 30000;

function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
	return results.map(({ thumbnail, frames, ...rest }) => rest);
}

function extractDomain(url: string): string {
	try { return new URL(url).hostname; } catch { return url; }
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function abortPendingFetches(): void {
	for (const c of pendingFetches.values()) c.abort();
	pendingFetches.clear();
}

function updateWidget(ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	const entries = activityMonitor.getEntries();
	const lines: string[] = [];
	lines.push(theme.fg("accent", "─── Web Search Activity " + "─".repeat(36)));
	if (entries.length === 0) {
		lines.push(theme.fg("muted", "  No activity yet"));
	} else {
		for (const e of entries) {
			const typeStr = e.type === "api" ? "API" : "GET";
			const target = e.type === "api"
				? `"${truncateToWidth(e.query || "", 28, "")}"`
				: truncateToWidth(e.url?.replace(/^https?:\/\//, "") || "", 30, "");
			const duration = e.endTime
				? `${((e.endTime - e.startTime) / 1000).toFixed(1)}s`
				: `${((Date.now() - e.startTime) / 1000).toFixed(1)}s`;
			let statusStr: string;
			let indicator: string;
			if (e.error) { statusStr = "err"; indicator = theme.fg("error", "✗"); }
			else if (e.status === null) { statusStr = "..."; indicator = theme.fg("warning", "⋯"); }
			else if (e.status === 0) { statusStr = "abort"; indicator = theme.fg("muted", "○"); }
			else { statusStr = String(e.status); indicator = e.status >= 200 && e.status < 300 ? theme.fg("success", "✓") : theme.fg("error", "✗"); }
			lines.push(`  ${typeStr.padEnd(4)} ${target.padEnd(32)} ${statusStr.padStart(5)} ${duration.padStart(5)} ${indicator}`);
		}
	}
	lines.push(theme.fg("accent", "─".repeat(60)));
	const rateInfo = activityMonitor.getRateLimitInfo();
	const resetMs = rateInfo.oldestTimestamp ? Math.max(0, rateInfo.oldestTimestamp + rateInfo.windowMs - Date.now()) : 0;
	lines.push(theme.fg("muted", `Rate: ${rateInfo.used}/${rateInfo.max}`) + (resetMs > 0 ? theme.fg("dim", ` (resets in ${Math.ceil(resetMs / 1000)}s)`) : ""));
	ctx.ui.setWidget("web-activity", new Text(lines.join("\n"), 0, 0));
}

function handleSessionChange(ctx: ExtensionContext): void {
	abortPendingFetches();
	clearCloneCache();
	sessionActive = true;
	restoreFromSession(ctx);
	widgetUnsubscribe?.();
	widgetUnsubscribe = null;
	activityMonitor.clear();
	if (widgetVisible) {
		widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
		updateWidget(ctx);
	}
}

function buildSearchReturn(
	queryList: string[],
	results: QueryResultData[],
	urls: string[],
	inlineContent: ExtractedContent[] | undefined,
	includeContent: boolean,
	pi: ExtensionAPI,
) {
	const sc = results.filter(r => !r.error).length;
	const tr = results.reduce((sum, r) => sum + r.results.length, 0);
	const outputParts: string[] = [];
	const duplicateQueries = new Map<string, number>();
	for (const r of results) duplicateQueries.set(r.query, (duplicateQueries.get(r.query) ?? 0) + 1);
	for (const { query, answer, results: res, error, provider } of results) {
		if (queryList.length > 1) {
			const suffix = (duplicateQueries.get(query) ?? 0) > 1 && provider ? ` (${provider})` : "";
			outputParts.push(`## Query: "${query}"${suffix}\n`);
		}
		if (error) outputParts.push(`Error: ${error}\n`);
		else if (res.length === 0) outputParts.push("No results found.\n");
		else outputParts.push(formatSearchSummary(res, answer) + "\n");
	}
	let output = outputParts.join("\n").trim();

	const hasInlineReady = inlineContent && inlineContent.length > 0 && urls.every(u => inlineContent!.some(c => c.url === u));
	let fetchId: string | null = null;
	if (hasInlineReady && inlineContent) {
		fetchId = generateId();
		const data: StoredSearchData = { id: fetchId, type: "fetch", timestamp: Date.now(), urls: inlineContent };
		storeResult(fetchId, data);
		pi.appendEntry("web-search-results", data);
		output += `\n---\nFull content for ${inlineContent.length} sources available [${fetchId}].`;
	} else if (includeContent) {
		fetchId = startBackgroundFetch(urls, pi);
		if (fetchId) output += `\n---\nContent fetching in background [${fetchId}]. Will notify when ready.`;
	}

	const searchId = generateId();
	const data: StoredSearchData = { id: searchId, type: "search", timestamp: Date.now(), queries: results };
	storeResult(searchId, data);
	pi.appendEntry("web-search-results", data);

	return {
		content: [{ type: "text" as const, text: output }],
		details: {
			queries: queryList, queryCount: queryList.length, successfulQueries: sc, totalResults: tr,
			includeContent, fetchId, fetchUrls: fetchId && !hasInlineReady ? urls : undefined, searchId,
		},
	};
}

function startBackgroundFetch(urls: string[], pi: ExtensionAPI): string | null {
	if (urls.length === 0) return null;
	const fetchId = generateId();
	const controller = new AbortController();
	pendingFetches.set(fetchId, controller);
	fetchAllContent(urls, controller.signal)
		.then(fetched => {
			if (!sessionActive || !pendingFetches.has(fetchId)) return;
			const data: StoredSearchData = { id: fetchId, type: "fetch", timestamp: Date.now(), urls: stripThumbnails(fetched) };
			storeResult(fetchId, data);
			pi.appendEntry("web-search-results", data);
			const ok = fetched.filter(f => !f.error).length;
			pi.sendMessage(
				{ customType: "web-search-content-ready", content: `Content fetched for ${ok}/${fetched.length} URLs [${fetchId}]. Full page content now available.`, display: true },
				{ triggerTurn: true },
			);
		})
		.catch(err => {
			if (!sessionActive || !pendingFetches.has(fetchId)) return;
			const message = err instanceof Error ? err.message : String(err);
			const isAbort = (err instanceof Error && err.name === "AbortError") || message.toLowerCase().includes("abort");
			if (!isAbort) {
				pi.sendMessage(
					{ customType: "web-search-error", content: `Content fetch failed [${fetchId}]: ${message}`, display: true },
					{ triggerTurn: false },
				);
			}
		})
		.finally(() => pendingFetches.delete(fetchId));
	return fetchId;
}

// ── Extension Entry ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Activity widget ──
	pi.registerShortcut("ctrl+shift+w", {
		description: "Toggle web search activity",
		handler: async (ctx) => {
			widgetVisible = !widgetVisible;
			if (widgetVisible) {
				widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
				updateWidget(ctx);
			} else {
				widgetUnsubscribe?.();
				widgetUnsubscribe = null;
				ctx.ui.setWidget("web-activity", null);
			}
		},
	});

	// ── Session lifecycle ──
	pi.on("session_start", async (_event, ctx) => handleSessionChange(ctx));
	pi.on("session_tree", async (_event, ctx) => handleSessionChange(ctx));
	pi.on("session_shutdown", () => {
		sessionActive = false;
		abortPendingFetches();
		clearCloneCache();
		clearResults();
		widgetUnsubscribe?.();
		widgetUnsubscribe = null;
		activityMonitor.clear();
		widgetVisible = false;
	});

	// ── web_search ──
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			`Search the web using Perplexity AI, Exa, or Gemini. Returns an AI-synthesized answer with source citations. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query — each query gets its own synthesized answer, so varying phrasing and scope gives much broader coverage. When includeContent is true, full page content is fetched in the background. Provider auto-selects: Exa (direct API with key, MCP fallback without), else Perplexity (needs key), else Gemini API (needs key), else Gemini Web (needs a supported Chromium-based browser login).`,
		promptSnippet:
			"Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage. Good: ['React vs Vue performance benchmarks 2026', 'React vs Vue developer experience comparison', 'React ecosystem size vs Vue ecosystem']. Bad: ['React vs Vue', 'React vs Vue comparison', 'React vs Vue review'] (too similar, redundant results)." })),
			numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
			recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" })),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
			provider: Type.Optional(StringEnum(["auto", "perplexity", "gemini", "exa"], { description: "Search provider (default: auto)" })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"], { description: "Thinking/reasoning level for LLM calls (Gemini search, query rewriting). Default: off." })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const rawQueryList: unknown[] = Array.isArray(params.queries)
				? params.queries
				: (params.query !== undefined ? [params.query] : []);
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) {
				return { content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }], details: { error: "No query provided" } };
			}

			const resolvedProvider = normalizeProviderInput(params.provider ?? loadConfig().provider);
			const searchResults: QueryResultData[] = [];
			const allUrls: string[] = [];
			const allInlineContent: ExtractedContent[] = [];

			for (let i = 0; i < queryList.length; i++) {
				const query = queryList[i];
				onUpdate?.({
					content: [{ type: "text", text: `Searching ${i + 1}/${queryList.length}: "${query}"...` }],
					details: { phase: "search", progress: i / queryList.length, currentQuery: query },
				});

				try {
					const { answer, results, inlineContent, provider } = await search(query, {
						provider: resolvedProvider,
						numResults: params.numResults,
						recencyFilter: params.recencyFilter,
						domainFilter: params.domainFilter,
						includeContent: params.includeContent,
						signal,
					});

					searchResults.push({ query, answer, results, error: null, provider });
					for (const r of results) { if (!allUrls.includes(r.url)) allUrls.push(r.url); }
					if (inlineContent) allInlineContent.push(...inlineContent);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const requestedProvider = typeof resolvedProvider === "string" && resolvedProvider !== "auto"
						? resolvedProvider : undefined;
					searchResults.push({ query, answer: "", results: [], error: message, provider: requestedProvider });
				}
			}

			return buildSearchReturn(queryList, searchResults, allUrls, allInlineContent.length > 0 ? allInlineContent : undefined, params.includeContent ?? false, pi);
		},

		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const rawQueryList: unknown[] = Array.isArray(input.queries) ? input.queries : (input.query !== undefined ? [input.query] : []);
			const ql = normalizeQueryList(rawQueryList);
			if (ql.length === 0) return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
			if (ql.length === 1) {
				const q = ql[0];
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${q.length > 60 ? q.slice(0, 57) + "..." : q}"`), 0, 0);
			}
			const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${ql.length} queries`)];
			for (const q of ql.slice(0, 5)) lines.push(theme.fg("muted", `  "${q.length > 50 ? q.slice(0, 47) + "..." : q}"`));
			if (ql.length > 5) lines.push(theme.fg("muted", `  ... and ${ql.length - 5} more`));
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as {
				queryCount?: number; successfulQueries?: number; totalResults?: number;
				error?: string; fetchId?: string; cancelled?: boolean; cancelReason?: string;
			};
			if (details?.cancelled) return new Text(theme.fg("error", `Cancelled: ${details.cancelReason}`), 0, 0);
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const sc = details?.successfulQueries ?? 0;
			const tc = details?.queryCount ?? 0;
			const tr = details?.totalResults ?? 0;
			const fetchId = details?.fetchId;
			const summary = theme.fg("success", `${sc}/${tc} queries`) + theme.fg("muted", `, ${tr} result${tr === 1 ? "" : "s"}`) + (fetchId ? theme.fg("muted", ` [bg fetch: ${fetchId}]`) : "");
			if (!expanded) return new Text(summary, 0, 0);
			const textContent = result.content.find(c => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(summary + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	// ── code_search ──
	pi.registerTool({
		name: "code_search",
		label: "Code Search",
		description: "Search for code examples, documentation, and API references. Returns relevant code snippets and docs from GitHub, Stack Overflow, and official documentation. Use for any programming question — API usage, library examples, debugging help.",
		promptSnippet: "Use for programming/API/library questions to retrieve concrete examples and docs before implementing or debugging code.",
		parameters: Type.Object({
			query: Type.String({ description: "Programming question, API, library, or debugging topic to search for" }),
			maxTokens: Type.Optional(Type.Integer({ minimum: 1000, maximum: 50000, description: "Maximum tokens of code/documentation context to return (default: 5000)" })),
		}),

		async execute(toolCallId, params, signal) {
			return executeCodeSearch(toolCallId, params, signal);
		},

		renderCall(args, theme) {
			const { query } = args as { query?: string };
			const display = !query ? "(no query)" : query.length > 70 ? query.slice(0, 67) + "..." : query;
			return new Text(theme.fg("toolTitle", theme.bold("code_search ")) + theme.fg("accent", display), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { query?: string; maxTokens?: number; error?: string };
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const summary = theme.fg("success", "code context returned") + theme.fg("muted", ` (${details?.maxTokens ?? 5000} tokens max)`);
			if (!expanded) return new Text(summary, 0, 0);
			const textContent = result.content.find(c => c.type === "text")?.text || "";
			return new Text(summary + "\n" + theme.fg("dim", textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent), 0, 0);
		},
	});

	// ── fetch_content ──
	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			"Fetch URL(s) and extract readable content as markdown. Supports YouTube video transcripts (with thumbnail), GitHub repository contents, and local video files (with frame thumbnail). Video frames can be extracted via timestamp/range or sampled across the entire video with frames alone. Falls back to Gemini for pages that block bots or fail Readability extraction. For YouTube and video files: ALWAYS pass the user's specific question via the prompt parameter — this directs the AI to focus on that aspect of the video, producing much better results than a generic extraction. Content is always stored and can be retrieved with get_search_content.",
		promptSnippet:
			"Use to extract readable content from URL(s), YouTube, GitHub repos, or local videos. For video questions, pass the user's exact question in prompt.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
			forceClone: Type.Optional(Type.Boolean({ description: "Force cloning large GitHub repositories that exceed the size threshold" })),
			prompt: Type.Optional(Type.String({ description: "Question or instruction for video analysis (YouTube and video files). Pass the user's specific question here — e.g. 'describe the book shown at the advice for beginners section'. Without this, a generic transcript extraction is used which may miss what the user is asking about." })),
			timestamp: Type.Optional(Type.String({ description: "Extract video frame(s) at a timestamp or time range. Single: '1:23:45', '23:45', or '85' (seconds). Range: '23:41-25:00' extracts evenly-spaced frames across that span (default 6). Use frames with ranges to control density; single+frames uses a fixed 5s interval. YouTube requires yt-dlp + ffmpeg; local videos require ffmpeg. Use a range when you know the approximate area but not the exact moment — you'll get a contact sheet to visually identify the right frame." })),
			frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: "Number of frames to extract. Use with timestamp range for custom density, with single timestamp to get N frames at 5s intervals, or alone to sample across the entire video. Requires yt-dlp + ffmpeg for YouTube, ffmpeg for local video." })),
			model: Type.Optional(Type.String({ description: "Override the Gemini model for video/YouTube analysis (e.g. 'gemini-2.5-flash', 'gemini-3-flash-preview'). Defaults to config or gemini-3-flash-preview." })),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const urls: string[] = params.urls ? [...params.urls] : (params.url ? [params.url] : []);
			if (urls.length === 0) return { content: [{ type: "text", text: "Error: No URL provided. Use 'url' or 'urls' parameter." }], details: { error: "No URL provided" } };

			onUpdate?.({ content: [{ type: "text", text: `Fetching ${urls.length} URL${urls.length === 1 ? "" : "s"}...` }], details: {} });
			const fetched = await fetchAllContent(urls, signal, {
				forceClone: params.forceClone,
				prompt: params.prompt,
				timestamp: params.timestamp,
				frames: params.frames,
				model: params.model,
			});

			const ok = fetched.filter(f => !f.error);
			const fetchId = generateId();
			const data: StoredSearchData = { id: fetchId, type: "fetch", timestamp: Date.now(), urls: fetched };
			storeResult(fetchId, data);

			const output = ok.map(f => {
				let text = f.content ?? "";
				if (f.thumbnail) text = `![thumbnail](${f.thumbnail})\n\n${text}`;
				if (f.frames?.length) {
					text = f.frames.map((fr, i) => `![frame ${i + 1}](${fr})`).join("\n") + "\n\n" + text;
				}
				return `# ${f.title}\n${f.url}\n\n${text}`;
			}).join("\n\n---\n\n");

			const errorList = fetched.filter(f => f.error).map(f => `- ${f.url}: ${f.error}`);
			const details: Record<string, unknown> = { fetchId, urlCount: urls.length, fetchedCount: ok.length };
			if (errorList.length) details.errors = errorList;

			return { content: [{ type: "text", text: output || "No content extracted." }], details };
		},

		renderCall(args, theme) {
			const { url, urls } = args as { url?: string; urls?: string[] };
			const list = urls ?? (url ? [url] : []);
			if (list.length === 0) return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			if (list.length === 1) {
				const u = list[0];
				const display = u.length > 70 ? u.slice(0, 67) + "..." : u;
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display.replace(/^https?:\/\//, "")), 0, 0);
			}
			return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${list.length} URLs`), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { fetchId?: string; urlCount?: number; fetchedCount?: number; errors?: string[] };
			const ok = details?.fetchedCount ?? 0;
			const total = details?.urlCount ?? 0;
			const summary = theme.fg("success", `${ok}/${total} fetched`) + (details?.fetchId ? theme.fg("muted", ` [${details.fetchId}]`) : "");
			if (!expanded) return new Text(summary, 0, 0);
			const textContent = result.content.find(c => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(summary + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	// ── get_search_content ──
	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Retrieve full content from a previous web_search or fetch_content call.",
		promptSnippet: "get_search_content: retrieve stored content from previous web_search/fetch_content calls",
		parameters: Type.Object({
			responseId: Type.String({ description: "The responseId from web_search or fetch_content" }),
			query: Type.Optional(Type.String({ description: "Get content for this query (web_search)" })),
			queryIndex: Type.Optional(Type.Integer({ description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Integer({ description: "Get content for URL at index" })),
		}),

		async execute(_toolCallId, params) {
			const { responseId, query, queryIndex, url, urlIndex } = params as {
				responseId: string; query?: string; queryIndex?: number; url?: string; urlIndex?: number;
			};
			const data = getResult(responseId);
			if (!data) return { content: [{ type: "text", text: `No data found for responseId: ${responseId}` }], details: {} };

			if (data.type === "search" && data.queries) {
				if (query !== undefined) {
					const q = data.queries.find(q => q.query === query);
					if (!q) return { content: [{ type: "text", text: `No results found for query "${query}" in response ${responseId}.` }], details: {} };
					return { content: [{ type: "text", text: formatQueryResult(q) }], details: { query: q.query, resultCount: q.results.length } };
				}
				if (queryIndex !== undefined) {
					const q = data.queries[queryIndex];
					if (!q) return { content: [{ type: "text", text: `No results at index ${queryIndex} for response ${responseId}.` }], details: {} };
					return { content: [{ type: "text", text: formatQueryResult(q) }], details: { query: q.query, resultCount: q.results.length } };
				}
				const all = data.queries.map(q => formatQueryResult(q)).join("\n\n---\n\n");
				return { content: [{ type: "text", text: all }], details: { responseId, type: "search" } };
			}

			if (data.type === "fetch" && data.urls) {
				if (url !== undefined) {
					const u = data.urls.find(u => u.url === url);
					if (!u) return { content: [{ type: "text", text: `No content found for URL "${url}" in response ${responseId}.` }], details: {} };
					return { content: [{ type: "text", text: `${u.title}\n${u.url}\n\n${u.content ?? ""}` }], details: { url: u.url } };
				}
				if (urlIndex !== undefined) {
					const u = data.urls[urlIndex];
					if (!u) return { content: [{ type: "text", text: `No content at index ${urlIndex} for response ${responseId}.` }], details: {} };
					return { content: [{ type: "text", text: `${u.title}\n${u.url}\n\n${u.content ?? ""}` }], details: { url: u.url } };
				}
				const all = data.urls.map((u: ExtractedContent) => `# ${u.title}\n${u.url}\n\n${u.content ?? ""}`).join("\n\n---\n\n");
				return { content: [{ type: "text", text: all }], details: { responseId, type: "fetch" } };
			}

			return { content: [{ type: "text", text: `No content available for responseId: ${responseId}` }], details: {} };
		},

		renderCall(args, theme) {
			const { responseId } = args as { responseId: string };
			return new Text(theme.fg("toolTitle", theme.bold("get_content ")) + theme.fg("muted", responseId.length > 20 ? responseId.slice(0, 17) + "..." : responseId), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { responseId?: string; type?: string; query?: string; url?: string; resultCount?: number };
			if (!details?.responseId) return new Text(theme.fg("error", "Not found"), 0, 0);
			const label = details.type === "fetch" ? "content" : "results";
			const target = details.query || details.url || "";
			const summary = theme.fg("success", label) + theme.fg("muted", ` from ${details.responseId.slice(0, 8)}...`) + (target ? theme.fg("accent", ` (${target.length > 30 ? target.slice(0, 27) + "..." : target})`) : "");
			if (!expanded) return new Text(summary, 0, 0);
			const textContent = result.content.find(c => c.type === "text")?.text || "";
			return new Text(summary + "\n" + theme.fg("dim", textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent), 0, 0);
		},
	});
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatQueryResult(q: QueryResultData): string {
	const parts = [`## Query: "${q.query}"`];
	if (q.error) { parts.push(`Error: ${q.error}`); return parts.join("\n"); }
	if (q.answer) parts.push(`\n${q.answer}`);
	parts.push("\n**Sources:**");
	for (const r of q.results.slice(0, 15)) parts.push(`- ${r.title}\n  ${r.url}`);
	if (q.results.length > 15) parts.push(`- ... and ${q.results.length - 15} more`);
	return parts.join("\n");
}
