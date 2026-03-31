"use client";

import { useKanbanConfig } from "@/hooks/useKanbanConfig";
import type { KanbanColumn } from "@/lib/types";
import { useState } from "react";
import { KanbanColumnEditor } from "./KanbanColumnEditor";

interface Props {
  repoName: string;
}

export function EnableKanbanButton({ repoName }: Props) {
  const { config, addColumn } = useKanbanConfig(repoName);
  const [showEditor, setShowEditor] = useState(false);

  // Don't show the button if kanban is already configured
  if (config && config.columns.length > 0) return null;

  return (
    <>
      <button
        onClick={() => setShowEditor(true)}
        className="has-tooltip flex items-center justify-center w-5 h-5 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
        title="Add kanban columns"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 4.5v15m6-15v15m-10.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125z" />
        </svg>
      </button>
      {showEditor && (
        <KanbanColumnEditor
          column={null}
          onSave={(column: KanbanColumn) => {
            addColumn(column);
            setShowEditor(false);
          }}
          onClose={() => setShowEditor(false)}
        />
      )}
    </>
  );
}
