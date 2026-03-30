"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { ClaudeSession } from "@/lib/types";

interface ElectronTerminalAPI {
  ptySpawn: (opts: { cols: number; rows: number; cwd: string; tmuxSession?: string; command?: string }) => Promise<{ ptyId: number }>;
  ptyWrite: (ptyId: number, data: string) => void;
  ptyResize: (ptyId: number, cols: number, rows: number) => void;
  ptyKill: (ptyId: number) => Promise<void>;
  onPtyData: (callback: (ptyId: number, data: string) => void) => () => void;
  onPtyExit: (callback: (ptyId: number, info: { exitCode: number; signal: number }) => void) => () => void;
}

function getElectronAPI(): ElectronTerminalAPI | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { electronAPI?: ElectronTerminalAPI }).electronAPI;
  return api?.ptySpawn ? api : null;
}

export function TerminalPanel({
  session,
  height,
  onClose,
  onRelaunch,
  spawnCommand,
}: {
  session: ClaudeSession;
  height: number;
  onClose: () => void;
  onRelaunch?: () => void;
  spawnCommand?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    const api = getElectronAPI();
    if (!api || !containerRef.current) return;

    // Resolve the CSS variable to an actual font-family name so xterm.js
    // gets a concrete value for its canvas/webgl font measurements.
    const resolvedFont = getComputedStyle(document.documentElement)
      .getPropertyValue("--font-geist-mono")
      .trim();
    const fontFamily = resolvedFont || 'Menlo, Monaco, "Courier New", monospace';

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily,
      theme: {
        background: "#0a0a0f",
        foreground: "#e4e4e7",
        cursor: "#e4e4e7",
        selectionBackground: "#3b82f640",
        black: "#09090b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#e4e4e7",
        brightBlack: "#52525b",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#fafafa",
      },
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Initial fit + WebGL
    requestAnimationFrame(() => {
      fitAddon.fit();
      try {
        term.loadAddon(new WebglAddon());
      } catch {
        // WebGL not available, fall back to canvas renderer
      }
    });

    let ptyId: number | null = null;
    let cleanupData: (() => void) | null = null;
    let cleanupExit: (() => void) | null = null;

    // Spawn PTY
    api
      .ptySpawn({
        cols: term.cols,
        rows: term.rows,
        cwd: session.workingDirectory,
        tmuxSession: spawnCommand ? undefined : (session.tmuxSession ?? undefined),
        command: spawnCommand,
      })
      .then((result) => {
        ptyId = result.ptyId;
        ptyIdRef.current = ptyId;

        // PTY → xterm
        cleanupData = api.onPtyData((id, data) => {
          if (id === ptyId) term.write(data);
        });

        // PTY exit
        cleanupExit = api.onPtyExit((id) => {
          if (id === ptyId) {
            term.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
            setExited(true);
          }
        });

        // xterm → PTY
        term.onData((data) => {
          if (ptyId !== null) api.ptyWrite(ptyId, data);
        });
      })
      .catch((err) => {
        term.write(`\x1b[31mFailed to spawn terminal: ${err.message}\x1b[0m\r\n`);
      });

    // Resize observer
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fitAddon.fit();
        if (ptyIdRef.current !== null) {
          api.ptyResize(ptyIdRef.current, term.cols, term.rows);
        }
      });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      cleanupData?.();
      cleanupExit?.();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      if (ptyIdRef.current !== null) {
        api.ptyKill(ptyIdRef.current).catch(() => {});
        ptyIdRef.current = null;
      }
    };
  }, [session.workingDirectory, spawnCommand]); // remount when directory or command changes

  // Re-fit when height changes
  useEffect(() => {
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      const api = getElectronAPI();
      const term = termRef.current;
      if (api && term && ptyIdRef.current !== null) {
        api.ptyResize(ptyIdRef.current, term.cols, term.rows);
      }
    });
  }, [height]);

  const handleRelaunch = useCallback(() => {
    setExited(false);
    onRelaunch?.();
  }, [onRelaunch]);

  const label = session.tmuxSession
    ? `tmux: ${session.tmuxSession}`
    : session.workingDirectory.replace(/.*\/([^/]+\/[^/]+)$/, "$1");

  return (
    <div className="flex flex-col flex-shrink-0 bg-[#0a0a0f] border-t border-white/5" style={{ height }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.02] border-b border-white/5 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <svg className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z"
            />
          </svg>
          <span className="text-xs text-zinc-400 truncate font-(family-name:--font-geist-mono)">
            {session.repoName}
          </span>
          {session.git?.branch && (
            <>
              <span className="text-zinc-700">/</span>
              <span className="text-xs text-zinc-500 truncate font-(family-name:--font-geist-mono)">
                {session.git.branch}
              </span>
            </>
          )}
          <span className="text-zinc-700">—</span>
          <span className="text-[11px] text-zinc-600 truncate font-(family-name:--font-geist-mono)">
            {label}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {exited && onRelaunch && (
            <button
              onClick={handleRelaunch}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-emerald-400 hover:text-emerald-300 bg-emerald-500/8 hover:bg-emerald-500/15 border border-emerald-500/20 hover:border-emerald-500/35 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              Relaunch
            </button>
          )}
          <button
            onClick={onClose}
            className="flex items-center justify-center w-6 h-6 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-white/5 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
      {/* Terminal container */}
      <div ref={containerRef} className="flex-1 min-h-0 px-1 py-1" />
    </div>
  );
}
