/**
 * DocFlow — reorder questions and group them into sections (spec FR-8.6).
 *
 * Reordering changes the order the person FILLING IN the document is asked
 * things, not where the blanks sit in the text. Those are different orders on
 * purpose: a contract may mention the client's name in the final clause while
 * it is obviously the first thing to ask for.
 *
 * Sections are plain labels on each field (`TemplateField.section`), so a
 * question can be moved between sections without any structural edit. Drag
 * between groups to reassign; drop into "Ungrouped" to clear it.
 */
import { useMemo, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { GripVertical, Plus, AlertTriangle, FolderOpen } from 'lucide-react';
import type { TemplateField } from '@/lib/api/templates';

const UNGROUPED = '__ungrouped__';

export interface QuestionReorderListProps {
  fields: TemplateField[];
  activeKey: string | null;
  onActiveKeyChange: (key: string) => void;
  /** Receives every field with its new order_index / section, in one go. */
  onReorder: (updates: { key: string; order_index: number; section: string | null }[]) => void;
  /** Flags a field that still needs configuring, for the warning dot. */
  hasIssue?: (field: TemplateField) => boolean;
}

export function QuestionReorderList({
  fields, activeKey, onActiveKeyChange, onReorder, hasIssue,
}: QuestionReorderListProps) {
  const [newSection, setNewSection] = useState('');
  const [adding, setAdding] = useState(false);

  const sensors = useSensors(
    // A small distance threshold so a click to select a question is not read
    // as the start of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** Fields in display order, bucketed by section. */
  const groups = useMemo(() => {
    const sorted = [...fields].sort(
      (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.key.localeCompare(b.key),
    );
    const map = new Map<string, TemplateField[]>();
    for (const f of sorted) {
      const key = (f.section || '').trim() || UNGROUPED;
      const bucket = map.get(key);
      if (bucket) bucket.push(f);
      else map.set(key, [f]);
    }
    // Named sections first, in the order their first question appears;
    // ungrouped questions sit at the end where they read as "not yet filed".
    const named = [...map.entries()].filter(([s]) => s !== UNGROUPED);
    const loose = map.get(UNGROUPED);
    return loose ? [...named, [UNGROUPED, loose] as const] : named;
  }, [fields]);

  const sectionNames = groups.map(([s]) => s).filter((s) => s !== UNGROUPED);

  /** Rebuild order_index across every group so the numbers stay contiguous. */
  const emit = (next: (readonly [string, TemplateField[]])[]) => {
    const updates: { key: string; order_index: number; section: string | null }[] = [];
    let index = 0;
    for (const [section, items] of next) {
      for (const field of items) {
        updates.push({
          key: field.key,
          order_index: index,
          section: section === UNGROUPED ? null : section,
        });
        index += 1;
      }
    }
    onReorder(updates);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) return;

    const mutable = groups.map(([s, items]) => [s, [...items]] as [string, TemplateField[]]);

    const from = mutable.find(([, items]) => items.some((f) => f.key === activeId));
    if (!from) return;
    const moving = from[1].find((f) => f.key === activeId)!;

    // Dropping on a section header moves the question into that section;
    // dropping on another question places it at that question's position.
    const targetSection = overId.startsWith('section:')
      ? overId.slice('section:'.length)
      : mutable.find(([, items]) => items.some((f) => f.key === overId))?.[0];
    if (targetSection === undefined) return;

    from[1].splice(from[1].indexOf(moving), 1);
    const to = mutable.find(([s]) => s === targetSection);
    if (!to) return;

    if (overId.startsWith('section:')) {
      to[1].push(moving);
    } else {
      const at = to[1].findIndex((f) => f.key === overId);
      to[1].splice(at < 0 ? to[1].length : at, 0, moving);
    }

    emit(mutable.filter(([s, items]) => items.length > 0 || s !== UNGROUPED));
  };

  const addSection = () => {
    const name = newSection.trim();
    if (!name || sectionNames.includes(name)) {
      setNewSection('');
      setAdding(false);
      return;
    }
    // A new section starts empty; the author drags questions into it. Creating
    // it pre-filled would guess at which questions belong together.
    const mutable = groups.map(([s, items]) => [s, [...items]] as [string, TemplateField[]]);
    const loose = mutable.find(([s]) => s === UNGROUPED);
    if (loose && loose[1].length > 0) {
      const moved = loose[1].shift()!;
      mutable.splice(mutable.length - 1, 0, [name, [moved]]);
      emit(mutable);
    }
    setNewSection('');
    setAdding(false);
  };

  if (fields.length === 0) return null;

  return (
    <section style={{ display: 'grid', gap: 10 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: '0.8rem', fontWeight: 700, color: 'var(--muted-foreground)' }}>
          Order of questions
        </h3>
        <span style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)', marginLeft: 'auto' }}>
          Drag to reorder
        </span>
      </header>

      <p style={{ margin: 0, fontSize: '0.74rem', color: 'var(--muted-foreground)', lineHeight: 1.45 }}>
        This is the order questions are asked in. It doesn&apos;t move the blanks
        in the document.
      </p>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div style={{ display: 'grid', gap: 12 }}>
          {groups.map(([section, items]) => (
            <div key={section} style={{ display: 'grid', gap: 6 }}>
              <SectionHeader
                id={`section:${section}`}
                label={section === UNGROUPED ? 'Ungrouped' : section}
                count={items.length}
              />
              <SortableContext
                items={items.map((f) => f.key)}
                strategy={verticalListSortingStrategy}
              >
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
                  {items.map((field, i) => (
                    <SortableQuestion
                      key={field.key}
                      field={field}
                      position={i + 1}
                      active={field.key === activeKey}
                      issue={hasIssue?.(field) ?? false}
                      onSelect={() => onActiveKeyChange(field.key)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </div>
          ))}
        </div>
      </DndContext>

      {adding ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="input"
            autoFocus
            value={newSection}
            placeholder="Section name"
            onChange={(e) => setNewSection(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addSection();
              if (e.key === 'Escape') { setNewSection(''); setAdding(false); }
            }}
            style={{ fontSize: '0.82rem' }}
          />
          <button type="button" onClick={addSection} className="btn btn-secondary btn-sm">Add</button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="btn btn-ghost btn-sm"
          style={{ justifySelf: 'start', fontSize: '0.76rem' }}
        >
          <Plus size={13} /> Add a section
        </button>
      )}
    </section>
  );
}

function SectionHeader({ id, label, count }: { id: string; label: string; count: number }) {
  // Droppable via useSortable with no sortable siblings: dropping a question
  // on the header appends it to that section.
  const { setNodeRef, isOver } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '4px 8px', borderRadius: 'var(--radius-sm)',
        background: isOver ? 'var(--secondary)' : 'transparent',
        border: `1px dashed ${isOver ? 'var(--primary)' : 'transparent'}`,
        fontSize: '0.74rem', fontWeight: 700,
        color: 'var(--muted-foreground)', textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      <FolderOpen size={12} aria-hidden="true" />
      {label}
      <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>({count})</span>
    </div>
  );
}

function SortableQuestion({ field, position, active, issue, onSelect }: {
  field: TemplateField;
  position: number;
  active: boolean;
  issue: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: field.key });

  return (
    <li
      ref={setNodeRef}
      style={{
        // Built by hand: @dnd-kit/utilities is not a direct dependency.
        transform: transform
          ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
          : undefined,
        transition,
        opacity: isDragging ? 0.55 : 1,
        zIndex: isDragging ? 2 : undefined,
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 9px', borderRadius: 'var(--radius-sm)',
          border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
          background: active ? 'var(--secondary)' : 'var(--card-solid)',
        }}
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${field.label || field.key}`}
          style={{
            display: 'inline-flex', border: 'none', background: 'transparent',
            cursor: 'grab', color: 'var(--muted-foreground)', padding: 2,
          }}
        >
          <GripVertical size={14} />
        </button>

        <button
          type="button"
          onClick={onSelect}
          style={{
            flex: 1, minWidth: 0, textAlign: 'left', border: 'none',
            background: 'transparent', cursor: 'pointer', padding: 0,
            color: 'var(--foreground)', fontSize: '0.82rem',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          <span style={{ color: 'var(--muted-foreground)', marginRight: 6 }}>{position}.</span>
          {field.label || <em style={{ color: 'var(--muted-foreground)' }}>Untitled question</em>}
        </button>

        {issue && (
          <AlertTriangle
            size={13}
            style={{ color: 'var(--status-pending)', flexShrink: 0 }}
            aria-label="Needs configuring"
          />
        )}
      </div>
    </li>
  );
}

export default QuestionReorderList;
