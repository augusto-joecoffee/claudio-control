import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { TerminalApp, TerminalOpenIn } from "./terminal/types";

const CONFIG_DIR = join(homedir(), ".claude-control");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface AppConfig {
  codeDirectories: string[];
  editor: string;
  gitGui: string;
  browser: string;
  notifications: boolean;
  notificationSound: boolean;
  terminalApp: TerminalApp;
  terminalOpenIn: TerminalOpenIn;
  terminalUseTmux: boolean;
  terminalTmuxMode: "per-project" | "choose";
}

export const EDITOR_OPTIONS = [
  { id: "vscode", label: "VS Code", command: "code", appName: "Code" },
  { id: "cursor", label: "Cursor", command: "cursor", appName: "Cursor" },
  { id: "zed", label: "Zed", command: "zed", appName: "Zed" },
  { id: "sublime", label: "Sublime Text", command: "subl", appName: "Sublime Text" },
  { id: "webstorm", label: "WebStorm", command: "webstorm", appName: "WebStorm" },
  { id: "intellij", label: "IntelliJ IDEA", command: "idea", appName: "IntelliJ IDEA" },
];

export const GIT_GUI_OPTIONS = [
  { id: "fork", label: "Fork", appName: "Fork" },
  { id: "sublime-merge", label: "Sublime Merge", appName: "Sublime Merge" },
  { id: "gitkraken", label: "GitKraken", appName: "GitKraken" },
  { id: "tower", label: "Tower", appName: "Tower" },
  { id: "sourcetree", label: "Sourcetree", appName: "Sourcetree" },
];

export const BROWSER_OPTIONS = [
  { id: "chrome", label: "Google Chrome", appName: "Google Chrome" },
  { id: "arc", label: "Arc", appName: "Arc" },
  { id: "safari", label: "Safari", appName: "Safari" },
  { id: "firefox", label: "Firefox", appName: "Firefox" },
  { id: "brave", label: "Brave", appName: "Brave Browser" },
  { id: "edge", label: "Microsoft Edge", appName: "Microsoft Edge" },
];

export const TERMINAL_APP_OPTIONS = [
  { id: "iterm", label: "iTerm2", appName: "iTerm" },
  { id: "terminal-app", label: "Terminal", appName: "Terminal" },
  { id: "ghostty", label: "Ghostty", appName: "Ghostty" },
  { id: "kitty", label: "kitty", appName: "kitty" },
  { id: "wezterm", label: "WezTerm", appName: "WezTerm" },
  { id: "alacritty", label: "Alacritty", appName: "Alacritty" },
];

export const TERMINAL_OPEN_IN_OPTIONS = [
  { id: "tab", label: "New tab" },
  { id: "window", label: "New window" },
];

export const TERMINAL_TMUX_MODE_OPTIONS = [
  { id: "per-project", label: "Session per project" },
  { id: "choose", label: "Choose when creating" },
];

const DEFAULT_CONFIG: AppConfig = {
  codeDirectories: [],
  editor: "vscode",
  gitGui: "fork",
  browser: "chrome",
  notifications: true,
  notificationSound: true,
  terminalApp: "terminal-app",
  terminalOpenIn: "tab",
  terminalUseTmux: false,
  terminalTmuxMode: "per-project",
};

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}
