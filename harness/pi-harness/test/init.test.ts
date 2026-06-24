import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .js bin, no types
import { mergeSettings, HARNESS_PACKAGES } from "../bin/init.js";

describe("mergeSettings", () => {
	it("adds every harness package as an npm: source to an empty config", () => {
		const { settings, added } = mergeSettings({}, HARNESS_PACKAGES);
		expect(settings.packages).toEqual(HARNESS_PACKAGES.map((n) => `npm:${n}`));
		expect(added).toEqual(HARNESS_PACKAGES);
	});

	it("preserves existing packages and user keys (non-destructive)", () => {
		const existing = {
			defaultModel: "claude-opus-4-8",
			packages: ["npm:some-other-pkg", "npm:@jc4649/pi-ralph"],
		};
		const { settings, added } = mergeSettings(existing, HARNESS_PACKAGES);
		expect(settings.defaultModel).toBe("claude-opus-4-8");
		// pre-existing entries kept, in place
		expect(settings.packages.slice(0, 2)).toEqual(["npm:some-other-pkg", "npm:@jc4649/pi-ralph"]);
		// pi-ralph not duplicated
		expect(settings.packages.filter((p: string) => p === "npm:@jc4649/pi-ralph")).toHaveLength(1);
		expect(added).not.toContain("@jc4649/pi-ralph");
		// input not mutated
		expect(existing.packages).toHaveLength(2);
	});

	it("disables built-in compaction only when unset", () => {
		expect(mergeSettings({}, HARNESS_PACKAGES).settings.compaction).toEqual({ enabled: false });
		const userChose = { compaction: { enabled: true } };
		expect(mergeSettings(userChose, HARNESS_PACKAGES).settings.compaction).toEqual({ enabled: true });
	});

	it("recognizes object-form package sources when deduping", () => {
		const existing = { packages: [{ source: "npm:@jc4649/notify", skills: [] }] };
		const { added } = mergeSettings(existing, HARNESS_PACKAGES);
		expect(added).not.toContain("@jc4649/notify");
	});
});
