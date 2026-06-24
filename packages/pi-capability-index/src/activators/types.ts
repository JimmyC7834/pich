import type { Capability, ActivationResult, Kind } from "../types.js";

export interface ToolControl { getActive(): string[]; setActive(names: string[]): void; }

export interface ActivatorDeps { sessionActive: Set<string>; tools?: ToolControl; }

export interface Activator {
  kind: Kind;
  activate(cap: Capability): ActivationResult;
}
