import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import register from "../../index";
import {
	getText,
	makeFakePiRegistry,
	makeToolContext,
	withTempFile,
} from "../support/fixtures";

vi.mock("../../src/file-kind", () => ({
	loadFileKindAndText: vi.fn(),
}));

import * as fileKindMod from "../../src/file-kind";

describe("read tool re-read awareness", () => {
	beforeEach(() => {
		vi.mocked(fileKindMod.loadFileKindAndText).mockReset();
		delete process.env.PI_HASHLINE_REREAD;
	});
	afterEach(() => {
		delete process.env.PI_HASHLINE_REREAD;
	});

	it("emits an unchanged notice on an identical full re-read", async () => {
		await withTempFile("a.txt", "alpha\nbeta\n", async ({ cwd }) => {
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
				kind: "text",
				text: "alpha\nbeta\n",
			});
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const read = getTool("read");

			const first = await read.execute("r1", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			expect(getText(first)).toContain(":alpha");

			const second = await read.execute("r2", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			expect(getText(second)).toContain("Unchanged since last read");
			expect(getText(second)).not.toContain(":beta");
		});
	});

	it("shows full content again on the read after a stub (loop-break)", async () => {
		await withTempFile("a.txt", "alpha\nbeta\n", async ({ cwd }) => {
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
				kind: "text",
				text: "alpha\nbeta\n",
			});
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const read = getTool("read");

			await read.execute("r1", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			await read.execute("r2", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd)); // stub
			const third = await read.execute("r3", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			expect(getText(third)).toContain(":alpha");
			expect(getText(third)).not.toContain("Unchanged since last read");
		});
	});

	it("emits a changed notice when content differs", async () => {
		await withTempFile("a.txt", "alpha\nbeta\n", async ({ cwd }) => {
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValueOnce({
				kind: "text",
				text: "alpha\nbeta\n",
			});
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const read = getTool("read");
			await read.execute("r1", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));

			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValueOnce({
				kind: "text",
				text: "alpha\nBETA\n",
			});
			const second = await read.execute("r2", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			expect(getText(second)).toContain("Changed since last read");
			expect(getText(second)).toContain("BETA");
		});
	});

	it("does not apply to windowed reads", async () => {
		await withTempFile("a.txt", "alpha\nbeta\n", async ({ cwd }) => {
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
				kind: "text",
				text: "alpha\nbeta\n",
			});
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const read = getTool("read");

			const first = await read.execute("r1", { path: "a.txt", limit: 1 }, undefined, undefined, makeToolContext(cwd));
			expect(getText(first)).toContain(":alpha");
			const second = await read.execute("r2", { path: "a.txt", limit: 1 }, undefined, undefined, makeToolContext(cwd));
			expect(getText(second)).not.toContain("Unchanged since last read");
			expect(getText(second)).toContain(":alpha");
		});
	});

	it("is disabled by PI_HASHLINE_REREAD=0", async () => {
		await withTempFile("a.txt", "alpha\nbeta\n", async ({ cwd }) => {
			process.env.PI_HASHLINE_REREAD = "0";
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
				kind: "text",
				text: "alpha\nbeta\n",
			});
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const read = getTool("read");

			await read.execute("r1", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			const second = await read.execute("r2", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			expect(getText(second)).not.toContain("Unchanged since last read");
			expect(getText(second)).toContain(":alpha");
		});
	});
});
