import useSWR from "swr";

interface ConfigResponse {
  config: {
    notifications: boolean;
    notificationSound: boolean;
    alwaysNotify: boolean;
    editor: string;
    gitGui: string;
    terminalApp: string;
    terminalUseTmux?: boolean;
    terminalTmuxMode?: string;
  } | null;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useSettings() {
  const { data } = useSWR<ConfigResponse>("/api/config", fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 0,
  });

  const config = data?.config;

  return {
    notifications: config?.notifications ?? true,
    notificationSound: config?.notificationSound ?? true,
    alwaysNotify: config?.alwaysNotify ?? false,
    // Assume editor/gitGui are available if configured (skip the expensive installed-app check)
    editorAvailable: !!config?.editor && config.editor !== "none",
    gitGuiAvailable: !!config?.gitGui && config.gitGui !== "none",
    inlineTerminal: config?.terminalApp === "inline",
    terminalUseTmux: config?.terminalUseTmux ?? false,
    terminalTmuxMode: (config?.terminalTmuxMode as "per-project" | "choose") ?? "per-project",
  };
}
