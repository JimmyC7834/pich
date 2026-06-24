import { describe, it, expect } from "vitest";
import { nudge } from "../src/nudge";

describe("nudge — cat → read", () => {
	it("nudges a bare single-file cat", () => {
		const n = nudge("cat src/utils.ts");
		expect(n?.rule).toBe("cat-read");
		expect(n?.tool).toBe("read");
		expect(n?.reason).toContain("read tool");
	});
	it("nudges cat with a numbering flag", () => {
		expect(nudge("cat -n src/a.ts")?.rule).toBe("cat-read");
	});
	it("passes cat with no file (stdin)", () => {
		expect(nudge("cat")).toBeNull();
	});
	it("passes a multi-file cat (concatenation)", () => {
		expect(nudge("cat a.ts b.ts")).toBeNull();
	});
});

describe("nudge — grep → grep", () => {
	it("nudges a bare grep with a path", () => {
		expect(nudge("grep foo src/a.ts")?.rule).toBe("grep");
	});
	it("nudges grep with recursive/line-number flags", () => {
		expect(nudge("grep -rn foo src")?.tool).toBe("grep");
	});
	it("passes grep with a context flag it cannot map", () => {
		expect(nudge("grep -A3 foo a.ts")).toBeNull();
	});
});

describe("nudge — find → find", () => {
	it("nudges a simple name search", () => {
		expect(nudge('find . -name "*.ts"')?.rule).toBe("find");
	});
	it("nudges a bare directory listing", () => {
		expect(nudge("find src")?.tool).toBe("find");
	});
	it("passes find with -type", () => {
		expect(nudge("find . -type f")).toBeNull();
	});
	it("passes find with -exec", () => {
		expect(nudge("find . -name x.ts -exec rm {}")).toBeNull();
	});
});

describe("nudge — sed -i → edit", () => {
	it("nudges an in-place sed", () => {
		const n = nudge("sed -i s/a/b/ file.ts");
		expect(n?.rule).toBe("sed-edit");
		expect(n?.tool).toBe("edit");
	});
	it("nudges in-place sed with a backup suffix", () => {
		expect(nudge("sed -i.bak s/a/b/ file.ts")?.rule).toBe("sed-edit");
	});
	it("passes a non-in-place sed (read-only stream)", () => {
		expect(nudge("sed s/a/b/ file.ts")).toBeNull();
	});
});

describe("nudge — never fires on composed or unrelated commands", () => {
	it("passes piped commands", () => {
		expect(nudge("cat a.ts | head")).toBeNull();
	});
	it("passes redirections", () => {
		expect(nudge("cat a.ts > out.txt")).toBeNull();
	});
	it("passes command substitution", () => {
		expect(nudge("grep foo $(ls)")).toBeNull();
	});
	it("passes chaining", () => {
		expect(nudge("cat a.ts && echo done")).toBeNull();
	});
	it("passes unrelated commands", () => {
		expect(nudge("npm test")).toBeNull();
	});
	it("passes empty input", () => {
		expect(nudge("   ")).toBeNull();
	});
});
