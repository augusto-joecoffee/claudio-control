import useSWR from "swr";

interface AppOption {
  id: string;
  installed: boolean;
}

interface SettingsResponse {
  config: {
    notifications: boolean;
    notificationSound: boolean;
    alwaysNotify: boolean;
    editor: string;
    gitGui: string;
    terminalApp: string;
  };
  options: {
    editors: AppOption[];
    gitGuis: AppOption[];
  };
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function isAppAvailable(options: AppOption[] | undefined, selectedId: string | undefined): boolean {
  if (!options || !selectedId || selectedId === "none") return false;
  return options.find((o) => o.id === selectedId)?.installed ?? false;
}

export function useSettings() {
  const { data } = useSWR<SettingsResponse>("/api/settings", fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 0,
  });

  return {
    notifications: data?.config?.notifications ?? true,
    notificationSound: data?.config?.notificationSound ?? true,
    alwaysNotify: data?.config?.alwaysNotify ?? false,
    editorAvailable: isAppAvailable(data?.options?.editors, data?.config?.editor),
    gitGuiAvailable: isAppAvailable(data?.options?.gitGuis, data?.config?.gitGui),
    inlineTerminal: data?.config?.terminalApp === "inline",
  };
}
