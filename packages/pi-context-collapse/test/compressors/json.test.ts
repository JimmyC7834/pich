import { describe, expect, it } from "vitest";
import { compressJson } from "../../src/compressors/json";

describe("compressJson", () => {
	it("summarizes an array of objects with count, shape, and a sample", () => {
		const arr = Array.from({ length: 200 }, (_, i) => ({ name: `r${i}`, stars: i }));
		const out = compressJson(JSON.stringify(arr));
		expect(out).toContain("array[200]");
		expect(out).toContain("name");
		expect(out).toContain("sample[0]=");
	});
	it("summarizes an object listing keys and array-valued key counts", () => {
		const obj = { user: { id: 1 }, repos: Array.from({ length: 50 }, (_, i) => ({ i })) };
		const out = compressJson(JSON.stringify(obj));
		expect(out).toContain("object{");
		expect(out).toContain("repos: array[50]");
	});
	it("is shorter than the input on bulky data", () => {
		const arr = Array.from({ length: 200 }, (_, i) => ({ name: `r${i}`, stars: i }));
		const input = JSON.stringify(arr);
		expect(compressJson(input).length).toBeLessThan(input.length);
	});
	it("does not emit 'undefined' for empty arrays", () => {
		const emptyArr: unknown[] = [];
		const outEmpty = compressJson(JSON.stringify(emptyArr));
		expect(outEmpty).toContain("array[0]");
		expect(outEmpty).not.toContain("undefined");

		const objWithEmptyArr = { items: [] };
		const outObjEmpty = compressJson(JSON.stringify(objWithEmptyArr));
		expect(outObjEmpty).toContain("items: array[0]");
		expect(outObjEmpty).not.toContain("undefined");
	});
});
