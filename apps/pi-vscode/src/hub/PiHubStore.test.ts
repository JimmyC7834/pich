import { test, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PiHubStore } from "./PiHubStore";

/** Fake PiBridge mirroring the methods PiHubStore touches. */
function makeBridge(connected = true, loadouts = { loadouts: [] as any[], active: "" as string }) {
  const bridge = new EventEmitter() as any;
  bridge.isConnected = () => connected;
  bridge.send = vi.fn().mockResolvedValue(undefined);
  bridge.listLoadouts = vi.fn().mockResolvedValue(loadouts);
  return bridge;
}

test("aggregates capabilities + loadouts into HubState and emits changed", async () => {
  vi.useFakeTimers();
  // listLoadouts (pulled on init) and the broadcast agree, so neither clobbers the other.
  const bridge = makeBridge(true, { loadouts: [{ name: "dev", description: "", skills: [], tools: [], mcp: [] }], active: "dev" });
  const store = new PiHubStore(bridge);
  const changed = vi.fn();
  store.on("changed", changed);
  bridge.emit("capabilities", { tools: [{ name: "read", description: "", source: "builtin", sourcePath: "", isActive: true }], skills: [], kBCollections: [], activeTools: ["read"], activeSkills: [] });
  bridge.emit("loadouts", { loadouts: [{ name: "dev", description: "", skills: [], tools: [], mcp: [] }], active: "dev" });
  await vi.advanceTimersByTimeAsync(60);
  expect(changed).toHaveBeenCalled();
  expect(store.state.tools[0].name).toBe("read");
  expect(store.state.activeLoadout).toBe("dev");
  vi.useRealTimers();
});

test("does not emit changed when state is unchanged", async () => {
  vi.useFakeTimers();
  const bridge = makeBridge();
  const store = new PiHubStore(bridge);
  bridge.emit("capabilities", { tools: [], skills: [], kBCollections: [], activeTools: [], activeSkills: [] });
  await vi.advanceTimersByTimeAsync(60);
  const changed = vi.fn();
  store.on("changed", changed);
  bridge.emit("capabilities", { tools: [], skills: [], kBCollections: [], activeTools: [], activeSkills: [] });
  await vi.advanceTimersByTimeAsync(60);
  expect(changed).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test("pulls a fresh snapshot on init when the bridge is already connected", async () => {
  // Regression: the hub store is created lazily AFTER pi-bridge has already
  // broadcast its one-shot capabilities/loadouts (on connect + session_start),
  // so it must proactively re-request them or the hub renders empty.
  vi.useFakeTimers();
  const bridge = makeBridge(true, {
    loadouts: [{ name: "dev", description: "", skills: [], tools: [], mcp: [] }],
    active: "dev",
  });
  const store = new PiHubStore(bridge);

  // Re-trigger the capabilities broadcast we may have missed.
  expect(bridge.send).toHaveBeenCalledWith({ type: "refresh_capabilities" }, false);
  // Loadouts aren't part of that re-broadcast — pull them directly.
  expect(bridge.listLoadouts).toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(100);
  expect(store.state.activeLoadout).toBe("dev");
  expect(store.state.loadouts[0].name).toBe("dev");
  vi.useRealTimers();
});

test("pulls a fresh snapshot when the bridge (re)connects later", async () => {
  vi.useFakeTimers();
  const bridge = makeBridge(false); // not connected at construction
  const store = new PiHubStore(bridge);
  expect(bridge.send).not.toHaveBeenCalled();

  bridge.isConnected = () => true;
  bridge.listLoadouts.mockResolvedValueOnce({
    loadouts: [{ name: "ops", description: "", skills: [], tools: [], mcp: [] }],
    active: "ops",
  });
  bridge.emit("connected");

  expect(bridge.send).toHaveBeenCalledWith({ type: "refresh_capabilities" }, false);
  await vi.advanceTimersByTimeAsync(100);
  expect(store.state.activeLoadout).toBe("ops");
  vi.useRealTimers();
});
