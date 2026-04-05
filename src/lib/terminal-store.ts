import type { TerminalEntry } from "./types";

const ORDER_KEY = "claude-control:terminal-order";

interface TerminalStoreState {
  terminals: Map<string, TerminalEntry>;
  activeDir: string | null;
  minimized: boolean;
  height: number;
}

const store: TerminalStoreState = {
  terminals: new Map(),
  activeDir: null,
  minimized: false,
  height: 400,
};

export function getTerminalStore(): TerminalStoreState {
  return store;
}

/** Read persisted tab order from localStorage. */
export function getSavedTerminalOrder(): string[] {
  try {
    return JSON.parse(localStorage.getItem(ORDER_KEY) || "[]");
  } catch {
    return [];
  }
}

/** Persist current tab order to localStorage. */
function saveTerminalOrder(terminals: Map<string, TerminalEntry>): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify([...terminals.keys()]));
  } catch { /* ignore */ }
}

export function setTerminalStore(state: Partial<TerminalStoreState>): void {
  if (state.terminals !== undefined) {
    store.terminals = state.terminals;
    saveTerminalOrder(state.terminals);
  }
  if (state.activeDir !== undefined) store.activeDir = state.activeDir;
  if (state.minimized !== undefined) store.minimized = state.minimized;
  if (state.height !== undefined) store.height = state.height;
}
