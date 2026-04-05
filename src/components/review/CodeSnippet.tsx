"use client";

import { memo, useMemo, useState } from "react";
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
type VisibleBlock = { type: "code"; startLine: number; endLine: number } | { type: "gap"; startLine: number; endLine: number };

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

function getTextContent(node: Element): string {
	let text = "";
	for (const child of node.children) {
		if (child.type === "text") text += (child as Text).value;
		else if (child.type === "element") text += getTextContent(child as Element);
	}
	return text;
}

function buildVisibleBlocks(
	snippet: CodeSnippetType,
	lines: string[],
	changedLines?: Set<number>,
	collapseUnchangedGaps?: boolean,
	contextRadius: number = 2,
): VisibleBlock[] {
	if (!collapseUnchangedGaps || !changedLines || lines.length === 0) {
		return [{ type: "code", startLine: snippet.startLine, endLine: snippet.endLine }];
	}

	const relevantChanged = Array.from(changedLines)
		.filter((line) => line >= snippet.startLine && line <= snippet.endLine)
		.sort((a, b) => a - b);

	if (relevantChanged.length === 0) {
		return [{ type: "code", startLine: snippet.startLine, endLine: snippet.endLine }];
	}

	const ranges: Array<{ start: number; end: number }> = [];
	for (const line of relevantChanged) {
		const start = Math.max(snippet.startLine, line - contextRadius);
		const end = Math.min(snippet.endLine, line + contextRadius);
		const last = ranges[ranges.length - 1];
		if (last && start <= last.end + 1) {
			last.end = Math.max(last.end, end);
		} else {
			ranges.push({ start, end });
		}
	}

	const blocks: VisibleBlock[] = [];
	let cursor = snippet.startLine;
	for (const range of ranges) {
		if (range.start > cursor) {
			blocks.push({ type: "gap", startLine: cursor, endLine: range.start - 1 });
		}
		blocks.push({ type: "code", startLine: range.start, endLine: range.end });
		cursor = range.end + 1;
	}
	if (cursor <= snippet.endLine) {
		blocks.push({ type: "gap", startLine: cursor, endLine: snippet.endLine });
	}

	return blocks;
}

interface CodeSnippetProps {
	snippet: CodeSnippetType;
	changedLines?: Set<number>;
	collapseUnchangedGaps?: boolean;
	onLineClick?: (line: number) => void;
	onExpandUp?: () => void;
	onExpandDown?: () => void;
	canExpandUp?: boolean;
	canExpandDown?: boolean;
}

export const CodeSnippetView = memo(function CodeSnippetView({
	snippet,
	changedLines,
	collapseUnchangedGaps,
	onLineClick,
	onExpandUp,
	onExpandDown,
	canExpandUp,
	canExpandDown,
}: CodeSnippetProps) {
	const lines = useMemo(() => (snippet.content ?? "").split("\n"), [snippet.content]);
	const [expandedGaps, setExpandedGaps] = useState<Set<string>>(new Set());

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

	const highlightedLines = useMemo(() => {
		if (!highlighted) return null;
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
					const innerText = getTextContent(el);
					if (innerText.includes("\n")) {
						walk(el.children as HastNode[]);
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
	}, [highlighted]);

	const visibleBlocks = useMemo(
		() => buildVisibleBlocks(snippet, lines, changedLines, collapseUnchangedGaps),
		[snippet, lines, changedLines, collapseUnchangedGaps],
	);

	const renderLine = (lineNum: number) => {
		const idx = lineNum - snippet.startLine;
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
						if (isChanged) {
							e.currentTarget.style.color = "#3fb950";
							e.currentTarget.style.background = "rgba(46, 160, 67, 0.2)";
						} else {
							e.currentTarget.style.color = "#484f58";
							e.currentTarget.style.background = "";
						}
					}}
				>
					{lineNum}
				</button>
				<span className="flex-1 pl-4 pr-2 whitespace-pre" style={{ color: "#c9d1d9" }}>
					{highlightedLines && highlightedLines[idx]
						? highlightedLines[idx]
						: lines[idx]}
				</span>
			</div>
		);
	};

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
				{visibleBlocks.map((block, blockIdx) => {
					if (block.type === "code") {
						const rendered = [];
						for (let lineNum = block.startLine; lineNum <= block.endLine; lineNum++) {
							rendered.push(renderLine(lineNum));
						}
						return <div key={`code-${block.startLine}-${block.endLine}`}>{rendered}</div>;
					}

					const gapKey = `${block.startLine}-${block.endLine}`;
					const expanded = expandedGaps.has(gapKey);
					if (expanded) {
						const rendered = [];
						for (let lineNum = block.startLine; lineNum <= block.endLine; lineNum++) {
							rendered.push(renderLine(lineNum));
						}
						return (
							<div key={`gap-open-${gapKey}`}>
								<button
									onClick={() => {
										setExpandedGaps((prev) => {
											const next = new Set(prev);
											next.delete(gapKey);
											return next;
										});
									}}
									className="w-full px-3 py-1 text-[10px] text-blue-400/60 hover:text-blue-400 hover:bg-blue-500/5 transition-colors flex items-center justify-center gap-1 border-y border-[#21262d]"
								>
									Hide {block.endLine - block.startLine + 1} unchanged lines
								</button>
								{rendered}
							</div>
						);
					}

					return (
						<button
							key={`gap-${gapKey}-${blockIdx}`}
							onClick={() => {
								setExpandedGaps((prev) => {
									const next = new Set(prev);
									next.add(gapKey);
									return next;
								});
							}}
							className="w-full px-3 py-1 text-[10px] text-zinc-500 hover:text-blue-400 hover:bg-blue-500/5 transition-colors flex items-center justify-center gap-1 border-y border-[#21262d]"
						>
							Show {block.endLine - block.startLine + 1} unchanged lines
						</button>
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
