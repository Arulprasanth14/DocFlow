/**
 * DocFlow — column show/hide/reorder for the documents table (spec FR-1.8).
 *
 * Reordering uses @dnd-kit (already installed for question reordering). The
 * transform string is built by hand rather than importing @dnd-kit/utilities,
 * which is only a transitive dependency here and not one we declared.
 *
 * The chosen layout persists per user in localStorage; a stored layout from an
 * older build is reconciled against the current column set on load, so adding
 * or removing a column never leaves someone with a broken table.
 */
import { useEffect, useRef, useState } from 'react';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Columns3, GripVertical, RotateCcw } from 'lucide-react';

export interface ColumnsMenuProps<K extends string> {
  /** Every reorderable/hideable column, in the user's current order. */
  order: K[];
  hidden: Set<K>;
  labels: Record<K, string>;
  onChange: (order: K[], hidden: Set<K>) => void;
  onReset: () => void;
}

export function ColumnsMenu<K extends string>({
  order, hidden, labels, onChange, onReset,
}: ColumnsMenuProps<K>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = order.indexOf(active.id as K);
    const to = order.indexOf(over.id as K);
    if (from < 0 || to < 0) return;
    onChange(arrayMove(order, from, to), hidden);
  };

  const toggle = (key: K) => {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    // Keep at least one optional column visible so the table never collapses
    // to just the title.
    else if (order.length - next.size > 1) next.add(key);
    onChange(order, next);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open} aria-haspopup="true"
        title="Choose and reorder columns"
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px',
          borderRadius: 'var(--radius)', border: '1px solid var(--border)',
          background: open ? 'var(--muted)' : 'var(--card)', color: 'var(--muted-foreground)',
          fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-sans)',
        }}>
        <Columns3 size={14} /> Columns
      </button>

      {open && (
        <div role="group" aria-label="Table columns" style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 20, width: 240,
          padding: 8, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)',
          background: 'var(--card-solid)', boxShadow: 'var(--shadow-lg)',
        }}>
          <p style={{
            margin: '2px 6px 8px', fontSize: '0.72rem', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted-foreground)',
          }}>Columns</p>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={order} strategy={verticalListSortingStrategy}>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {order.map((key) => (
                  <ColumnRow key={key} id={key} label={labels[key]}
                    checked={!hidden.has(key)} onToggle={() => toggle(key)} />
                ))}
              </ul>
            </SortableContext>
          </DndContext>

          <button onClick={() => { onReset(); setOpen(false); }} style={{
            display: 'flex', alignItems: 'center', gap: 6, width: '100%', marginTop: 6,
            padding: '7px 8px', background: 'none', border: 'none', borderRadius: 'var(--radius)',
            cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: '0.78rem',
            color: 'var(--muted-foreground)',
          }}>
            <RotateCcw size={12} /> Reset to default
          </button>
        </div>
      )}
    </div>
  );
}

function ColumnRow({ id, label, checked, onToggle }: {
  id: string; label: string; checked: boolean; onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
        borderRadius: 'var(--radius)', background: isDragging ? 'var(--muted)' : 'transparent',
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
      }}
    >
      <button
        {...attributes} {...listeners}
        aria-label={`Reorder ${label}`} title="Drag to reorder"
        style={{
          display: 'inline-flex', background: 'none', border: 'none', padding: 2,
          cursor: 'grab', color: 'var(--muted-foreground)', touchAction: 'none',
        }}>
        <GripVertical size={13} />
      </button>
      <label style={{
        display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer',
        fontSize: '0.82rem', color: 'var(--foreground)',
      }}>
        <input type="checkbox" checked={checked} onChange={onToggle}
          style={{ accentColor: 'var(--primary)', cursor: 'pointer' }} />
        {label}
      </label>
    </li>
  );
}

export default ColumnsMenu;
