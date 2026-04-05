"use client";

import { memo, useCallback, useMemo, useState } from "react";
import { refractor as _refractor } from "refractor";
import type { Element, Text } from "hast";
import type { CodeSnippet as CodeSnippetType } from "@/lib/types";
import "./syntax-theme.css";

const EXT_TO_LANG: Record<string, string> = {
	ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin",
	c: "c", h: "c", cpp: "cpp", cc: "cpp", cs: "csharp",
	html: "markup", htm: "markup", xml: "markup", svg: "markup",
	css: "css", scss: "css", less: "css",
	json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
	sh: "bash", bash: "bash", zsh: "bash",
	md: "markdown", mdx: "markdown",
	sql: "sql", graphql: "graphql", gql: "graphql",
	swift: "swift", dart: "dart", lua: "lua", r: "r",
};

function detectLang(filePath: string): string | null {
	const name = filePath.split("/").pop()?.toLowerCase() ?? "";
	if (name === "dockerfile") return "docker";
	if (name === "makefile") return "makefile";
	const ext = name.split(".").pop() ?? "";
	const lang = EXT_TO_LANG[ext];
	if (!lang) return null;
	try {
		if (_refractor.registered(lang)) return lang;
	} catch { /* ignore */ }
	return null;
}

type HastNode = Element | Text | { type: string; children?: HastNode[]; value?: string };

function renderNodes(nodes: HastNode[], key: string = ""): React.ReactNode[] {
	return nodes.map((node, i) => {
		if (node.type === "text") return (node as Text).value;
		if (node.type === "element") {
			const el = node as Element;
			const className = (el.properties?.className as string[] | undefined)?.join(" ");
			return (
				<span key={`${key}-${i}`} className={className}>
					{el.children ? renderNodes(el.children as HastNode[], `${key}-${i}`) : null}
				</span>
			);
		}
		return null;
	});
}

interface CodeSnippetProps {
	snippet: CodeSnippetType;
	changedLines?: Set<number>;
	onLineClick?: (line: number) => void;
	onExpandUp?: () => void;
	onExpandDown?: () => void;
	canExpandUp?: boolean;
	canExpandDown?: boolean;
}

export const CodeSnippetView = memo(function CodeSnippetView({
	snippet,
	changedLines,
	onLineClick,
	onExpandUp,
	onExpandDown,
	canExpandUp,
	canExpandDown,
}: CodeSnippetProps) {
	const lines = useMemo(() => (snippet.content ?? "").split("\n"), [snippet.content]);

	const lang = useMemo(() => detectLang(snippet.filePath), [snippet.filePath]);

	const highlighted = useMemo(() => {
		if (!lang || !snippet.content) return null;
		try {
			const root = _refractor.highlight(snippet.content, lang);
			return root.children as HastNode[];
		} catch {
			return null;
		}
	}, [lang, snippet.content]);

	// When highlighted, split into per-line spans
	const highlightedLines = useMemo(() => {
		if (!highlighted) return null;
		// Flatten the highlighted AST into per-line chunks
		const allText = (snippet.content ?? "").split("\n");
		const lineNodes: React.ReactNode[][] = [];
		let currentLine: React.ReactNode[] = [];
		let charIdx = 0;

		function walk(nodes: HastNode[]) {
			for (const node of nodes) {
				if (node.type === "text") {
					const text = (node as Text).value;
					const parts = text.split("\n");
					for (let p = 0; p < parts.length; p++) {
						if (p > 0) {
							lineNodes.push(currentLine);
							currentLine = [];
						}
						if (parts[p]) currentLine.push(parts[p]);
					}
					charIdx += text.length;
				} else if (node.type === "element") {
					const el = node as Element;
					const className = (el.properties?.className as string[] | undefined)?.join(" ");
					// Check if this element spans multiple lines
					const innerText = getTextContent(el);
					if (innerText.includes("\n")) {
						// Recurse into children to split by line
						const saved = currentLine.length;
						walk(el.children as HastNode[]);
						// Wrap segments that were added
					} else {
						currentLine.push(
							<span key={`h-${charIdx}`} className={className}>
								{renderNodes(el.children as HastNode[], `h-${charIdx}`)}
							</span>,
						);
						charIdx += innerText.length;
					}
				}
			}
		}

		walk(highlighted);
		if (currentLine.length > 0) lineNodes.push(currentLine);

		return lineNodes;
	}, [highlighted, snippet.content]);

	return (
		<div className="diff-viewer-container rounded border border-[#21262d] bg-[#0d1117] overflow-hidden text-[12px] leading-5" style={{ fontFamily: "var(--font-geist-mono), monospace" }}>
			{canExpandUp && onExpandUp && (
				<button
					onClick={onExpandUp}
					className="w-full px-3 py-1 text-[10px] text-blue-400/60 hover:text-blue-400 hover:bg-blue-500/5 transition-colors flex items-center justify-center gap-1"
				>
					<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
						<path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
					</svg>
					Show more
				</button>
			)}
			<div className="overflow-x-auto">
				{lines.map((line, i) => {
					const lineNum = snippet.startLine + i;
					const isChanged = changedLines?.has(lineNum) ?? false;
					return (
						<div
							key={lineNum}
							className="flex"
							style={isChanged ? { background: "rgba(46, 160, 67, 0.15)" } : undefined}
						>
							<button
								onClick={() => onLineClick?.(lineNum)}
								className="w-10 shrink-0 text-right pr-2 select-none cursor-pointer transition-colors border-r border-[#21262d]"
								style={isChanged
									? { background: "rgba(46, 160, 67, 0.2)", color: "#3fb950" }
									: { color: "#484f58" }
								}
								onMouseEnter={(e) => { e.currentTarget.style.color = "#58a6ff"; e.currentTarget.style.background = "rgba(56, 139, 253, 0.1)"; }}
								onMouseLeave={(e) => {
									if (isChanged) { e.currentTarget.style.color = "#3fb950"; e.currentTarget.style.background = "rgba(46, 160, 67, 0.2)"; }
									else { e.currentTarget.style.color = "#484f58"; e.currentTarget.style.background = ""; }
								}}
							>
								{lineNum}
							</button>
							<span className="flex-1 pl-4 pr-2 whitespace-pre" style={{ color: "#c9d1d9" }}>
								{highlightedLines && highlightedLines[i]
									? highlightedLines[i]
									: line}
							</span>
						</div>
					);
				})}
			</div>
			{canExpandDown && onExpandDown && (
				<button
					onClick={onExpandDown}
					className="w-full px-3 py-1 text-[10px] text-blue-400/60 hover:text-blue-400 hover:bg-blue-500/5 transition-colors flex items-center justify-center gap-1"
				>
					<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
						<path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
					</svg>
					Show more
				</button>
			)}
		</div>
	);
});

function getTextContent(node: Element): string {
	let text = "";
	for (const child of node.children) {
		if (child.type === "text") text += (child as Text).value;
		else if (child.type === "element") text += getTextContent(child as Element);
	}
	return text;
}
