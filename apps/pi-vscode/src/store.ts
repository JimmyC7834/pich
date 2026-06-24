import { EventEmitter } from "node:events";
import type { PiState, SessionInfo, KBCollection, SkillItem, FileChange, CapabilitiesSnapshot } from "./types";

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface PiStore {
  on(event: "changed", listener: () => void): this;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class PiStore extends EventEmitter {
  state: PiState = { isStreaming: false };
  sessions: SessionInfo[] = [];
  activeSession = "";
  collections: KBCollection[] = [];
  files: FileChange[] = [];
  skills: SkillItem[] = [];
  capabilities: CapabilitiesSnapshot | null = null;

  updateState(partial: Partial<PiState>): void {
    Object.assign(this.state, partial);
    this.emit("changed");
  }

  setSessions(sessions: SessionInfo[], active: string): void {
    this.sessions = sessions;
    this.activeSession = active;
    this.emit("changed");
  }

  setCollections(collections: KBCollection[]): void {
    this.collections = collections;
    this.emit("changed");
  }

  addFileChange(change: FileChange): void {
    const idx = this.files.findIndex(f => f.path === change.path);
    if (idx >= 0) this.files.splice(idx, 1);
    this.files.unshift(change);
    this.emit("changed");
  }

  setSkills(skills: SkillItem[]): void {
    this.skills = skills;
    this.emit("changed");
  }

  clearFiles(): void {
    this.files = [];
    this.emit("changed");
  }

  setCapabilities(snapshot: CapabilitiesSnapshot): void {
    this.capabilities = snapshot;
    this.emit("changed");
  }

  reset(): void {
    this.state = { isStreaming: false };
    this.sessions = [];
    this.activeSession = "";
    this.collections = [];
    this.files = [];
    this.skills = [];
    this.capabilities = null;
    this.emit("changed");
  }

  /** Capture the full store contents (used to mirror one session into the view store). */
  snapshot(): StoreSnapshot {
    return {
      state: this.state,
      sessions: this.sessions,
      activeSession: this.activeSession,
      collections: this.collections,
      files: this.files,
      skills: this.skills,
      capabilities: this.capabilities,
    };
  }

  /** Replace the full store contents from a snapshot and notify listeners. */
  loadSnapshot(s: StoreSnapshot): void {
    this.state = s.state;
    this.sessions = s.sessions;
    this.activeSession = s.activeSession;
    this.collections = s.collections;
    this.files = s.files;
    this.skills = s.skills;
    this.capabilities = s.capabilities;
    this.emit("changed");
  }
}

export interface StoreSnapshot {
  state: PiState;
  sessions: SessionInfo[];
  activeSession: string;
  collections: KBCollection[];
  files: FileChange[];
  skills: SkillItem[];
  capabilities: CapabilitiesSnapshot | null;
}
