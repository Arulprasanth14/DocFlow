/**
 * DocFlow — Freeform document editor (/documents/:id/edit)
 *
 * The destination for "Blank document" (spec conflict C12): *"Blank document
 * opens the same Word-like editor in freeform mode, autosaves as draft, and then
 * joins the submission wizard at the Workflow step (skipping Form Fill)."*
 *
 * Same editor as the Template Studio (shared toolbar + paper canvas), minus the
 * placeholder node — a blank document has no blanks (§19 screen 4, FR-3.4).
 * Body is persisted to DocumentContent; the title to the document itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { PagedCanvas } from '@/components/editor/PagedCanvas';
import { OutlinePane } from '@/components/editor/OutlinePane';
import { pasteProps } from '@/components/editor/pasteCleaner';
import { createExtensions } from '@/components/editor/extensions';
import { ArrowRight, Lightbulb, LightbulbOff, Lock, RotateCw, Sparkles } from 'lucide-react';

import { EditorToolbar } from '@/components/editor/EditorToolbar';
import { FindReplaceBar } from '@/components/editor/FindReplaceBar';
import { AIAssistantPanel } from '@/components/ai/AIAssistantPanel';
import { ValidationSummary } from '@/components/ui/ValidationSummary';
import { useGhostText } from '@/hooks/useGhostText';
import { useAIAvailability } from '@/hooks/useAI';
import type { FieldProblem } from '@/types';
import {
  useDeleteDocument, useDocument, useDocumentContent, useSaveDocumentContent } from '@/hooks/useDocuments';
import documentsApi from '@/lib/api/documents';
import { PageHeader } from '@/components/ui/PageHeader';
import { SaveIndicator } from '@/components/ui/SaveIndicator';
import StatusBadge from '@/components/ui/StatusBadge';
import type { SaveState } from '@/hooks/useAutosave';
import type { Document } from '@/types';
import type { DocumentContent } from '@/lib/api/documents';

const AUTOSAVE_MS = 1500;
const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

function isEmptyContent(c: unknown): boolean {
  if (!c || typeof c !== 'object') return true;
  const doc = c as { type?: string; content?: unknown[] };
  return doc.type !== 'doc' || !Array.isArray(doc.content) || doc.content.length === 0;
}

export default function DocumentEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: doc, isLoading: docLoading, isError: docError, refetch } = useDocument(id);
  const { data: body, isLoading: bodyLoading } = useDocumentContent(id);

  if (docLoading || bodyLoading) {
    return <div className="page-content" style={{ paddingTop: 48, textAlign: 'center' }}>
      <div className="spinner" style={{ width: 32, height: 32, margin: '0 auto' }} />
    </div>;
  }
  if (docError || !doc) {
    return <div className="page-content" style={{ paddingTop: 48, maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
      <p style={{ fontWeight: 700, color: 'var(--foreground)' }}>Couldn't open this document</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 14 }}>
        <button className="btn btn-secondary" onClick={() => refetch()}><RotateCw size={14} /> Retry</button>
        <button className="btn btn-primary" onClick={() => navigate('/documents')}>All documents</button>
      </div>
    </div>;
  }
  return <Surface key={doc.id} doc={doc} body={body} />;
}

function Surface({ doc, body }: { doc: Document; body?: DocumentContent }) {
  const navigate = useNavigate();
  const saveContent = useSaveDocumentContent();
  const deleteDoc = useDeleteDocument();

  const locked = doc.status !== 'draft';
  const [title, setTitle] = useState(doc.title);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  // FR-6.2 — page view is opt-in, so the default stays the continuous canvas
  // people are already used to.
  const [paged, setPaged] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  // E — what the server says is blocking "Continue".
  const [blockers, setBlockers] = useState<FieldProblem[]>([]);
  const [checking, setChecking] = useState(false);

  const ai = useAIAvailability();
  // The editor is built once; this ref keeps "/ai" in step with the current
  // availability, which arrives a moment after the first render.
  const slashAIRef = useRef<() => boolean>(() => false);
  // FR-10.1 — see TemplateEditorPage: the ref is the live switch, read by
  // the plugin on every tick so toggling it does not rebuild the editor.
  const ghostRef = useRef<{ enabled: boolean; fetch: (b: string) => Promise<string> }>({
    enabled: false,
    fetch: async () => '',
  });
  const ghost = useGhostText({ available: !!ai.enabled, documentId: doc.id });
  ghostRef.current = { enabled: ghost.config.enabled, fetch: ghost.config.fetchSuggestion };
  slashAIRef.current = () => {
    if (!ai.enabled || locked) return false;
    setAiOpen(true);
    return true;
  };

  /**
   * FR-14.9 — discard this draft.
   *
   * window.confirm rather than the app's ConfirmDialog: this page has no
   * dialog host of its own, and adding one for a single destructive action
   * is more surface than the action deserves. The wording still says what
   * happens.
   */
  const discardDraft = async () => {
    if (locked) return;
    const sure = window.confirm(
      'Discard this draft?\n\n'
      + 'It will be removed from your documents. Nothing is sent to anyone, '
      + 'and an administrator can still recover it if this was a mistake.',
    );
    if (!sure) return;
    await deleteDoc.mutateAsync(doc.id);
    navigate('/documents');
  };

  const versionRef = useRef<number>(doc.version ?? 1);
  const titleDirty = useRef(false);
  const contentDirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const titleRef = useRef(title);
  useEffect(() => { titleRef.current = title; }, [title]);

  // FR-6.6 — Ctrl/Cmd+F opens the editor's own find & replace. The browser's
  // find can't replace, and can't see ProseMirror's document state.
  useEffect(() => {
    if (locked) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked]);

  const editor = useEditor({
    immediatelyRender: false,
    editable: !locked,
    extensions: createExtensions({
      placeholders: false,
      onSlashAI: () => slashAIRef.current(),
      ghost: {
        enabled: true,  // the ref below is the real switch
        fetchSuggestion: (before) =>
          (ghostRef.current.enabled ? ghostRef.current.fetch(before) : Promise.resolve('')),
      },
    }),
    content: isEmptyContent(body?.content) ? EMPTY_DOC : (body?.content as object),
    // FR-6.4 — strip Word's presentation markup on paste; keep the structure.
    editorProps: {
      ...pasteProps,
      // FR-6.4 native spell-check. Browsers default this on for
      // contenteditable, but stating it means a future editorProps change
      // cannot silently turn it off.
      attributes: { 'aria-label': 'Document body', spellcheck: 'true' },
    },
    onUpdate: ({ editor: ed }) => {
      setWordCount(ed.getText().split(/\s+/).filter(Boolean).length);
      contentDirty.current = true;
      schedule();
    },
  });
  editorRef.current = editor;

  // Point 3 / FR-3.4: "cursor placed in the first line" so the user can just type.
  useEffect(() => {
    if (!editor || locked) return;
    editor.commands.focus('start');
    setWordCount(editor.getText().split(/\s+/).filter(Boolean).length);
  }, [editor, locked]);

  const flush = useCallback(async () => {
    if (locked) return;
    if (!titleDirty.current && !contentDirty.current) return;
    setSaveState('saving');
    try {
      if (titleDirty.current) {
        // If-Match path → throttled version snapshots instead of one per keystroke.
        const updated = await documentsApi.autosaveDocument(
          doc.id, { title: titleRef.current.trim() || 'Untitled document' }, versionRef.current,
        );
        versionRef.current = updated.version ?? versionRef.current + 1;
        titleDirty.current = false;
      }
      if (contentDirty.current && editorRef.current) {
        await saveContent.mutateAsync({
          docId: doc.id,
          data: { content: editorRef.current.getJSON() as Record<string, unknown> },
        });
        contentDirty.current = false;
      }
      setSaveState('saved');
      setLastSavedAt(new Date());
    } catch {
      setSaveState('error');
    }
  }, [doc.id, locked, saveContent]);

  const schedule = useCallback(() => {
    if (locked) return;
    setSaveState('unsaved');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, AUTOSAVE_MS);
  }, [flush, locked]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /** D5 — the paragraph the cursor is in, and nothing more. */
  const aiContext = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return '';
    return ed.state.selection.$from.parent.textContent.slice(0, 1500);
  }, []);

  const insertAIDraft = (text: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    // Plain paragraphs: the reply is text, and feeding it in as HTML would
    // let a stray tag into the body.
    ed.chain().focus().insertContent(
      text.split(/\n{2,}/).map((para) => ({
        type: 'paragraph',
        content: para.trim() ? [{ type: 'text', text: para.trim() }] : [],
      })),
    ).run();
    contentDirty.current = true;
    schedule();
  };

  /**
   * E — a blank document needs a real title and a real body before it can
   * go anywhere.
   *
   * The rules live on the server (`document_validation`), so this flushes
   * the pending autosave first and then ASKS, rather than keeping a second
   * copy of the rules here that could drift. The submit endpoint runs the
   * same checks again at the end.
   */
  const continueToWorkflow = async () => {
    if (timer.current) clearTimeout(timer.current);
    setBlockers([]);
    await flush();
    setChecking(true);
    try {
      const res = await documentsApi.submitCheck(doc.id, { stage: 'write' });
      if (!res.ok) { setBlockers(res.errors); return; }
      navigate(`/documents/${doc.id}/submit`);
    } catch {
      // The check itself failed (offline, server down). Blocking here would
      // trap a finished document behind a transient fault, and the submit
      // endpoint validates again anyway.
      navigate(`/documents/${doc.id}/submit`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="page-content" style={{ paddingTop: 24, maxWidth: 1000, margin: '0 auto' }}>
      <button onClick={() => navigate('/documents')} className="btn btn-ghost btn-sm" style={{ marginBottom: 12, paddingLeft: 0 }}>← All documents</button>
      <PageHeader
        breadcrumbs={[{ label: 'Documents' }, { label: doc.public_id }, { label: 'Write' }]}
        title="Write your document"
        description="Type freely. Everything saves automatically — then choose an approval workflow."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {!locked && <SaveIndicator state={saveState} lastSavedAt={lastSavedAt} onRetry={() => void flush()} />}
            <button className="btn btn-primary" onClick={continueToWorkflow} disabled={locked || checking}>
              {checking ? 'Checking…' : 'Continue'} <ArrowRight size={15} />
            </button>
          </div>
        }
      />
      <div style={{ height: 16 }} />

      {locked && (
        <div role="status" style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', marginBottom: 14,
          borderRadius: 'var(--radius)', background: 'var(--muted)', border: '1px solid var(--border)',
          color: 'var(--muted-foreground)', fontSize: '0.85rem',
        }}>
          <Lock size={15} />
          This document is <StatusBadge status={doc.status} /> and can no longer be edited.
        </div>
      )}

      <ValidationSummary
        errors={blockers}
        fieldIds={{ title: 'doc-title', body: 'doc-body' }}
      />

      <input
        id="doc-title"
        className="input" value={title} disabled={locked} aria-label="Document title"
        onChange={(e) => { setTitle(e.target.value); titleDirty.current = true; schedule(); }}
        placeholder="Document title"
        style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: 12 }}
      />

      <EditorToolbar
        editor={locked ? null : editor}
        documentId={doc.id}
        paged={paged}
        onPagedChange={setPaged}
        outlineOpen={outlineOpen}
        onOutlineToggle={() => setOutlineOpen((o) => !o)}
        onFind={locked ? undefined : () => setFindOpen(true)}
      />
      {/* FR-6.6 — not offered on a locked document: there is nothing to replace. */}
      <FindReplaceBar
        editor={locked ? null : editor}
        open={findOpen && !locked}
        onClose={() => setFindOpen(false)}
      />
      {/* FR-6.6 — outline beside the page on a wide screen, above it when
          there is no room for a second column. */}
      <div style={{
        display: 'grid', gap: 16, alignItems: 'start',
        gridTemplateColumns: [
          'minmax(0, 1fr)',
          outlineOpen ? '232px' : '',
          aiOpen ? '300px' : '',
        ].filter(Boolean).join(' '),
      }}>
        {/* id + tabIndex so a "Fix this" link can land on the body. */}
        <div
          id="doc-body"
          tabIndex={-1}
          onFocus={() => editorRef.current?.commands.focus('start')}
          style={{ outline: 'none' }}
        >
          <PagedCanvas enabled={paged} onPageCountChange={setPageCount}>
            <EditorContent editor={editor} />
          </PagedCanvas>
        </div>
        {outlineOpen && (
          <div style={{ position: 'sticky', top: 72 }}>
            <OutlinePane editor={editor} />
          </div>
        )}
        {aiOpen && !locked && (
          <div style={{ position: 'sticky', top: 72 }}>
            <AIAssistantPanel
              open={aiOpen}
              onClose={() => setAiOpen(false)}
              onInsert={insertAIDraft}
              getContext={aiContext}
              documentId={doc.id}
            />
          </div>
        )}
      </div>

      <div style={{
        display: 'flex', gap: 16, marginTop: 10, padding: '8px 4px',
        fontSize: '0.78rem', color: 'var(--muted-foreground)',
      }}>
        <span>{wordCount} word{wordCount === 1 ? '' : 's'}</span>
        {paged && (
          <span title="Approximate: the exported PDF decides the final page breaks.">
            {pageCount} page{pageCount === 1 ? '' : 's'} (approx.)
          </span>
        )}
        <button
          type="button"
          onClick={() => setPaged((p) => !p)}
          aria-pressed={paged}
          className="btn btn-ghost btn-sm"
          style={{ fontSize: '0.76rem', padding: '2px 8px' }}
        >
          {paged ? 'Continuous view' : 'Page view'}
        </button>
        <button
          type="button"
          onClick={() => setOutlineOpen((o) => !o)}
          aria-pressed={outlineOpen}
          className="btn btn-ghost btn-sm"
          style={{ fontSize: '0.76rem', padding: '2px 8px' }}
        >
          {outlineOpen ? 'Hide outline' : 'Outline'}
        </button>
        {/* FR-10.1 — same panel the "/ai" shortcut opens. */}
        {ai.enabled && !locked && (
          <button
            type="button"
            onClick={() => setAiOpen((o) => !o)}
            aria-pressed={aiOpen}
            className="btn btn-ghost btn-sm"
            style={{ fontSize: '0.76rem', padding: '2px 8px' }}
          >
            <Sparkles size={13} /> Write with AI
          </button>
        )}
        {/* FR-10.1 — inline completion, off by default. Tab accepts. */}
        {ai.enabled && !locked && (
          <button
            type="button"
            onClick={ghost.toggle}
            aria-pressed={ghost.on}
            className="btn btn-ghost btn-sm"
            style={{ fontSize: '0.76rem', padding: '2px 8px' }}
            title={ghost.on
              ? 'Stop suggesting the next few words as you type'
              : 'Suggest the next few words as you type. Press Tab to accept.'}
          >
            {ghost.on ? <Lightbulb size={13} /> : <LightbulbOff size={13} />}
            {ghost.on ? 'Suggestions on' : 'Suggest as I type'}
          </button>
        )}
        {/* FR-14.9 — "Explicit Discard draft is ALWAYS available", so it
            belongs here too, not only on the detail page. */}
        {!locked && (
          <button
            type="button"
            onClick={discardDraft}
            disabled={deleteDoc.isPending}
            className="btn btn-ghost btn-sm"
            style={{ fontSize: '0.76rem', padding: '2px 8px', color: 'var(--status-rejected-fg)' }}
          >
            {deleteDoc.isPending ? 'Discarding…' : 'Discard draft'}
          </button>
        )}
        <span style={{ marginLeft: 'auto' }}>Next: choose an approval workflow</span>
      </div>
      <div style={{ height: 40 }} />
    </div>
  );
}
