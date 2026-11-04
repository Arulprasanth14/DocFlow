/**
 * DocFlow — resizable split view (spec FR-15.2 shared components, FR-8.2/FR-12.2).
 *
 * Used by Field Configuration (author time) and Form Fill (use time): document
 * on the left, question panel on the right, draggable divider between them.
 *
 * Built on react-resizable-panels **v4**, whose API is `Group` / `Panel` /
 * `Separator` (v2's `PanelGroup` / `PanelResizeHandle` no longer exist).
 *
 * FR-8.7: below 1024 px the panes stack and the document becomes a collapsible
 * mini-preview, so the question is never squeezed on a phone.
 */
import { useEffect, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';

const STACK_BREAKPOINT = 1024;

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < STACK_BREAKPOINT,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${STACK_BREAKPOINT - 1}px)`);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  /** Persists the divider position per surface. */
  storageKey?: string;
  /** Left pane width as a percentage on first load. */
  defaultLeft?: number;
  /** Heading for the collapsible preview when the panes stack. */
  stackedLeftLabel?: string;
  leftLabel?: string;
  rightLabel?: string;
}

export function SplitPane({
  left, right, storageKey, defaultLeft = 58,
  stackedLeftLabel = 'Document preview',
  leftLabel = 'Document', rightLabel = 'Questions',
}: SplitPaneProps) {
  const narrow = useIsNarrow();
  const [previewOpen, setPreviewOpen] = useState(false);

  const [layout, setLayout] = useState<Record<string, number> | undefined>(() => {
    if (!storageKey) return undefined;
    try {
      const raw = localStorage.getItem(`docflow.split.${storageKey}`);
      return raw ? (JSON.parse(raw) as Record<string, number>) : undefined;
    } catch { return undefined; }
  });

  // ── Stacked (< 1024 px): sticky mini-preview above the question (FR-8.7) ──
  if (narrow) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <section aria-label={leftLabel} style={{
          border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
          background: 'var(--card-solid)', overflow: 'hidden',
          position: 'sticky', top: 8, zIndex: 2,
        }}>
          <button
            onClick={() => setPreviewOpen((o) => !o)}
            aria-expanded={previewOpen}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
              padding: '10px 14px', background: 'transparent', border: 'none', cursor: 'pointer',
              fontFamily: 'var(--font-sans)', fontSize: '0.84rem', fontWeight: 700,
              color: 'var(--foreground)',
            }}>
            {stackedLeftLabel}
            {previewOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
          {previewOpen && (
            <div style={{ maxHeight: '45vh', overflow: 'auto', padding: 12, borderTop: '1px solid var(--border)' }}>
              {left}
            </div>
          )}
        </section>
        <section aria-label={rightLabel}>{right}</section>
      </div>
    );
  }

  return (
    <Group
      orientation="horizontal"
      defaultLayout={layout}
      onLayoutChanged={(next) => {
        setLayout(next);
        if (!storageKey) return;
        try { localStorage.setItem(`docflow.split.${storageKey}`, JSON.stringify(next)); }
        catch { /* private mode — the divider just won't be remembered */ }
      }}
      style={{ alignItems: 'stretch', minHeight: 420 }}
    >
      <Panel id="left" defaultSize={defaultLeft} minSize={30} aria-label={leftLabel}>
        <div style={{ height: '100%', overflow: 'auto', paddingRight: 4 }}>{left}</div>
      </Panel>

      <Separator
        aria-label="Resize panels"
        style={{
          width: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'col-resize', color: 'var(--muted-foreground)',
        }}
      >
        <span aria-hidden style={{
          width: 4, height: 38, borderRadius: 999, background: 'var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} />
        <GripVertical size={12} style={{ position: 'absolute', pointerEvents: 'none', opacity: 0.6 }} />
      </Separator>

      <Panel id="right" minSize={26} aria-label={rightLabel}>
        <div style={{ height: '100%', overflow: 'auto', paddingLeft: 4 }}>{right}</div>
      </Panel>
    </Group>
  );
}

export default SplitPane;
