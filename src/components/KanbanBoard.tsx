"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  ClaudeSession,
  KanbanCardPlacement,
  KanbanColumn as KanbanColumnType,
  KanbanConfig,
  KanbanState,
} from "@/lib/types";
import { type ReactNode, useRef, useState } from "react";
import { KanbanColumn } from "./KanbanColumn";

// Draggable card wrapper for kanban boards
function KanbanDraggableCard({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { type: "kanban-card", sessionId: id },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing">
      {children}
    </div>
  );
}

// Draggable column wrapper — drag handle is the column header
function DraggableColumn({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `col-${id}`,
    data: { type: "kanban-column-sort", columnId: id },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

function UnstagedColumn({ sessions, renderCard }: { sessions: ClaudeSession[]; renderCard: (s: ClaudeSession) => ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: "column-__unstaged__",
    data: { type: "kanban-unstaged" },
  });

  return (
    <div className="flex flex-col w-[380px] flex-shrink-0">
      <div className="flex items-center gap-2 mb-3 px-1">
        <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Unstaged</h3>
        <span className="text-[10px] text-zinc-600 font-(family-name:--font-geist-mono)">
          {sessions.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 min-h-[120px] rounded-lg border transition-colors p-2 space-y-3 ${
          isOver
            ? "border-zinc-500/50 bg-zinc-800/30"
            : "border-zinc-800/50 bg-zinc-900/20"
        }`}
      >
        {sessions.map((session) => (
          <div key={session.id}>{renderCard(session)}</div>
        ))}
        {sessions.length === 0 && (
          <div className="flex items-center justify-center h-20 text-zinc-700 text-xs">
            Drop sessions here
          </div>
        )}
      </div>
    </div>
  );
}

// Pointer-first collision detection: use cursor position when inside a droppable,
// fall back to closest-center so empty columns are still reachable.
const pointerThenCenter: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  if (pointerHits.length > 0) return pointerHits;
  return closestCenter(args);
};

interface KanbanBoardProps {
  config: KanbanConfig;
  state: KanbanState;
  sessions: ClaudeSession[];
  renderCard: (session: ClaudeSession) => ReactNode;
  onMoveCard: (sessionId: string, toColumnId: string) => void;
  onUnstageCard: (sessionId: string) => void;
  onReorderInColumn: (columnId: string, sessionIds: string[]) => void;
  onReorderColumns: (columnIds: string[]) => void;
  onEditColumn: (columnId: string) => void;
  onAddColumn: () => void;
}

export function KanbanBoard({
  config,
  state,
  sessions,
  renderCard,
  onMoveCard,
  onUnstageCard,
  onReorderInColumn,
  onReorderColumns,
  onEditColumn,
  onAddColumn,
}: KanbanBoardProps) {
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // Track which column a card is visually in during drag
  const [overColumnId, setOverColumnId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // Group sessions by column placement, preserving placement order
  const getSessionsForColumn = (columnId: string): ClaudeSession[] => {
    const placedIds = state.placements
      .filter((p) => p.columnId === columnId)
      .map((p) => p.sessionId);
    const sessionMap = new Map(sessions.map((s) => [s.id, s]));
    return placedIds.map((id) => sessionMap.get(id)).filter(Boolean) as ClaudeSession[];
  };

  // Sessions not assigned to any column
  const assignedIds = new Set(state.placements.map((p) => p.sessionId));
  const unassignedSessions = sessions.filter((s) => !assignedIds.has(s.id));

  // Find which column a session is in
  const getColumnForSession = (sessionId: string): string | null => {
    const placement = state.placements.find((p) => p.sessionId === sessionId);
    return placement?.columnId ?? null;
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) {
      setOverColumnId(null);
      return;
    }
    // Don't update card-over state when dragging columns
    if (active.data.current?.type === "kanban-column-sort") return;

    // Check if hovering over a column drop zone
    const overData = over.data.current;
    if (overData?.type === "kanban-unstaged") {
      setOverColumnId("__unstaged__");
    } else if (overData?.type === "kanban-column") {
      setOverColumnId(overData.columnId as string);
    } else if (overData?.type === "kanban-card") {
      // Hovering over a card — find which column that card is in
      const overId = over.id as string;
      const col = getColumnForSession(overId);
      setOverColumnId(col ?? "__unstaged__");
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    setOverColumnId(null);

    if (!over || active.id === over.id) return;

    // Column reorder
    if (active.data.current?.type === "kanban-column-sort") {
      const overType = over.data.current?.type;
      if (overType !== "kanban-column-sort") return;
      const columnIds = config.columns.map((c) => `col-${c.id}`);
      const oldIndex = columnIds.indexOf(active.id as string);
      const newIndex = columnIds.indexOf(over.id as string);
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const rawIds = config.columns.map((c) => c.id);
        onReorderColumns(arrayMove(rawIds, oldIndex, newIndex));
      }
      return;
    }

    // Card drag handling
    const sessionId = active.id as string;
    let targetColumnId: string | null = null;

    const overData = over.data.current;
    if (overData?.type === "kanban-unstaged") {
      const currentColumn = getColumnForSession(sessionId);
      if (currentColumn) onUnstageCard(sessionId);
      return;
    }
    if (overData?.type === "kanban-column") {
      targetColumnId = overData.columnId as string;
    } else if (overData?.type === "kanban-card") {
      const col = getColumnForSession(over.id as string);
      if (!col) {
        // Card is in unstaged — treat as unstage
        const currentColumn = getColumnForSession(sessionId);
        if (currentColumn) onUnstageCard(sessionId);
        return;
      }
      targetColumnId = col;
    }

    if (!targetColumnId) return;

    const currentColumn = getColumnForSession(sessionId);
    if (currentColumn === targetColumnId) {
      // Same column — reorder within column
      const columnSessions = getSessionsForColumn(targetColumnId);
      const ids = columnSessions.map((s) => s.id);
      const oldIndex = ids.indexOf(sessionId);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        onReorderInColumn(targetColumnId, arrayMove(ids, oldIndex, newIndex));
      }
      return;
    }

    onMoveCard(sessionId, targetColumnId);
  };

  // Freeze sessions during drag to prevent SWR poll disruption
  const stableSessionsRef = useRef(sessions);
  if (!activeDragId) {
    stableSessionsRef.current = sessions;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerThenCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 overflow-x-auto pb-2">
        {/* Unstaged column — always visible, droppable */}
        <UnstagedColumn
          sessions={unassignedSessions}
          renderCard={(session) => (
            <KanbanDraggableCard id={session.id}>{renderCard(session)}</KanbanDraggableCard>
          )}
        />

        {/* Kanban columns — sortable horizontally */}
        <SortableContext items={config.columns.map((c) => `col-${c.id}`)} strategy={horizontalListSortingStrategy}>
          {config.columns.map((column, idx) => (
            <DraggableColumn key={column.id} id={column.id}>
              <KanbanColumn
                column={column}
                sessions={getSessionsForColumn(column.id)}
                placements={state.placements}
                renderCard={(session) => (
                  <KanbanDraggableCard id={session.id}>{renderCard(session)}</KanbanDraggableCard>
                )}
                onEditColumn={onEditColumn}
                isLast={idx === config.columns.length - 1}
              />
            </DraggableColumn>
          ))}
        </SortableContext>

        {/* Add column button */}
        <button
          onClick={onAddColumn}
          className="flex flex-col items-center justify-center min-w-[160px] min-h-[120px] rounded-lg border border-dashed border-zinc-800 hover:border-zinc-600 text-zinc-600 hover:text-zinc-400 transition-colors mt-8"
        >
          <svg className="w-5 h-5 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span className="text-xs">Add Column</span>
        </button>
      </div>

      {/* Drag overlay */}
      <DragOverlay dropAnimation={null}>
        {activeDragId && (() => {
          const session = sessions.find((s) => s.id === activeDragId);
          if (!session) return null;
          return (
            <div
              className="pointer-events-none opacity-90 shadow-2xl shadow-black/50 rounded-xl ring-1 ring-white/10"
              style={{ width: 340 }}
            >
              {renderCard(session)}
            </div>
          );
        })()}
      </DragOverlay>
    </DndContext>
  );
}
