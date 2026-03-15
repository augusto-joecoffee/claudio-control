import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  loadConfig,
  saveConfig,
  AppConfig,
  EDITOR_OPTIONS,
  GIT_GUI_OPTIONS,
  BROWSER_OPTIONS,
  TERMINAL_APP_OPTIONS,
  TERMINAL_OPEN_IN_OPTIONS,
  TERMINAL_TMUX_MODE_OPTIONS,
} from "@/lib/config";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

async function checkInstalledApps<T extends { appName: string }>(
  options: T[],
  alwaysInstalled?: Set<string>,
): Promise<(T & { installed: boolean })[]> {
  return Promise.all(
    options.map(async (opt) => {
      if (alwaysInstalled?.has(opt.appName)) return { ...opt, installed: true };
      try {
        await execFileAsync("open", ["-Ra", opt.appName], { timeout: 3000 });
        return { ...opt, installed: true };
      } catch {
        return { ...opt, installed: false };
      }
    })
  );
}

export async function GET() {
  try {
    const [config, terminalApps, browsers] = await Promise.all([
      loadConfig(),
      checkInstalledApps(TERMINAL_APP_OPTIONS, new Set(["Terminal"])),
      checkInstalledApps(BROWSER_OPTIONS, new Set(["Safari"])),
    ]);
    return NextResponse.json({
      config,
      options: {
        editors: EDITOR_OPTIONS,
        gitGuis: GIT_GUI_OPTIONS,
        browsers,
        terminalApps,
        terminalOpenIn: TERMINAL_OPEN_IN_OPTIONS,
        terminalTmuxModes: TERMINAL_TMUX_MODE_OPTIONS,
      },
    });
  } catch (error) {
    console.error("Failed to load settings:", error);
    return NextResponse.json({ error: "Failed to load settings" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const current = await loadConfig();

    const updated: AppConfig = {
      codeDirectories: body.codeDirectories ?? current.codeDirectories,
      editor: body.editor ?? current.editor,
      gitGui: body.gitGui ?? current.gitGui,
      browser: body.browser ?? current.browser,
      notifications: body.notifications ?? current.notifications,
      notificationSound: body.notificationSound ?? current.notificationSound,
      terminalApp: body.terminalApp ?? current.terminalApp,
      terminalOpenIn: body.terminalOpenIn ?? current.terminalOpenIn,
      terminalUseTmux: body.terminalUseTmux ?? current.terminalUseTmux,
      terminalTmuxMode: body.terminalTmuxMode ?? current.terminalTmuxMode,
    };

    await saveConfig(updated);
    return NextResponse.json({ config: updated });
  } catch (error) {
    console.error("Failed to save settings:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
