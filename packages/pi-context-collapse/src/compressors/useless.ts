// Useless-result elision: a search/lookup that found nothing carries no signal
// worth keeping in context. Blank it to a fixed notice. Ported from oh-my-pi's
// `AgentToolResult.useless` flag (it tags zero-match search, empty inbox drains,
// timed-out polls). We can't see a tool's intent, so we detect by shape instead.

export const USELESS_NOTICE = "[Uneventful result elided]";

// Tools whose empty output unambiguously means "found nothing" (vs bash, where
// empty output usually means the command succeeded — never elide that).
const SEARCH_TOOLS = new Set([
	"grep",
	"find",
	"code_search",
	"kb_search",
	"capability_search",
	"vocab_find",
	"vocab_usages",
	"web_search",
	"get_search_content",
]);

const NO_MATCH_RE =
	/\b(no matches?|0 matches|no results?|nothing found|no files? found|no matching|0 results?|found 0)\b/i;

/** True when the result is a content-free search outcome. Conservative by design. */
export function isUseless(toolName: string, text: string): boolean {
	const t = text.trim();
	if (SEARCH_TOOLS.has(toolName) && t.length === 0) return true;
	// A short result whose substance is a "no matches" phrase (a few lines of
	// query echo + the verdict). Long output that merely contains the phrase is
	// left to the real compressors.
	if (NO_MATCH_RE.test(t) && t.split("\n").length <= 4) return true;
	return false;
}

export function compressUseless(_text: string): string {
	return USELESS_NOTICE;
}
