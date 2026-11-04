/**
 * DocFlow — Template Studio editor (/documents/templates/:id/edit)
 *
 * Spec flow A (§7.2): A2a Write → A3 Detect blanks → A4 Configure questions
 * (split view) → A5 Preview & checklist → A6 Publish. Those map onto the three
 * stages below; the stepper lets the author move back at any time with state
 * preserved (FR-11.6).
 *
 * §8.6 Word-like editor · §8.7 placeholder system · §8.8 field configuration ·
 * §8.11 preview & publish gate · §8.14 autosave. There is no manual "Save".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { PagedCanvas, hasAuthoredFurniture, readPageFurniture, readPageSettings } from '@/components/editor/PagedCanvas';
import { OutlinePane } from '@/components/editor/OutlinePane';
import { pasteProps } from '@/components/editor/pasteCleaner';

import { AlertTriangle, CheckCircle2, Lightbulb, LightbulbOff, RotateCw, Rocket, ScanLine, Sparkles } from 'lucide-react';

import { EditorToolbar } from '@/components/editor/EditorToolbar';
import { EditorTipBar } from '@/components/editor/EditorTipBar';
import { AIAssistantPanel } from '@/components/ai/AIAssistantPanel';
import { countBlankRuns } from '@/components/editor/blankText';
import { PLACEHOLDER_NODE, newPlaceholderId } from '@/components/editor/PlaceholderNode';
import { createExtensions } from '@/components/editor/extensions';
import { scanPlaceholders, blanksSummary, type ScanResult } from '@/components/editor/placeholderScanner';
import { FieldConfigPanel, fieldIssue } from '@/components/editor/FieldConfigPanel';
import { AIBlankDetectPanel } from '@/components/ai/AIBlankDetectPanel';
import { TemplateVersionHistory } from '@/components/templates/TemplateVersionHistory';
import { FindReplaceBar } from '@/components/editor/FindReplaceBar';
import { useGhostText } from '@/hooks/useGhostText';
import { useAIAvailability, useDetectBlanks, useAIDecision } from '@/hooks/useAI';
import type { DetectedBlank } from '@/lib/api/ai';
import { DocumentPreview } from '@/components/editor/DocumentPreview';
import { SplitPane } from '@/components/ui/SplitPane';
import { Stepper, type Step } from '@/components/ui/Stepper';
import {
  useTemplate, useUpdateTemplate, usePublishTemplate, usePublishCheck,
  useDetectTemplateBlanks,
} from '@/hooks/useTemplates';
import type { TemplateDetail, TemplateField } from '@/lib/api/templates';
import { PageHeader } from '@/components/ui/PageHeader';
import { SaveIndicator } from '@/components/ui/SaveIndicator';
import type { SaveState } from '@/hooks/useAutosave';

const AUTOSAVE_MS = 1500;
const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

const STAGES: Step[] = [
  { key: 'write', label: 'Write' },
  { key: 'configure', label: 'Questions' },
  { key: 'publish', label: 'Preview & publish' },
];

const countWords = (ed: Editor) => ed.getText().split(/\s+/).filter(Boolean).length;

function isEmptyContent(c: unknown): boolean {
  if (!c || typeof c !== 'object') return true;
  const doc = c as { type?: string; content?: unknown[] };
  return doc.type !== 'doc' || !Array.isArray(doc.content) || doc.content.length === 0;
}

/** Sample answers for Try-it mode (FR-11.1) — clearly placeholder-ish, never
 *  presented as real data; the toggle says "sample data". */
function sampleAnswer(f: TemplateField): string {
  switch (f.type) {
    case 'number': return '42';
    case 'currency': return '1,250.00';
    case 'date': return new Date().toISOString().slice(0, 10);
    case 'email': return 'sample@example.com';
    case 'phone': return '+91 90000 00000';
    case 'yesno': return 'Yes';
    case 'checkbox': return 'Yes';
    case 'dropdown':
    case 'radio': {
      const first = (f.options || [])[0];
      if (first == null) return 'Sample option';
      return typeof first === 'object'
        ? String((first as Record<string, unknown>).label ?? 'Sample option')
        : String(first);
    }
    case 'textarea': return `Sample ${(f.label || 'text').toLowerCase()} — two or three lines of example content.`;
    default: return `Sample ${(f.label || 'value').toLowerCase()}`;
  }
}

export default function TemplateEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: template, isLoading, isError, refetch } = useTemplate(id);

  if (isLoading) {
    return <div className="page-content" style={{ paddingTop: 48, textAlign: 'center' }}>
      <div className="spinner" style={{ width: 32, height: 32, margin: '0 auto' }} />
    </div>;
  }
  if (isError || !template) {
    return <div className="page-content" style={{ paddingTop: 48, maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
      <p style={{ fontWeight: 700, color: 'var(--foreground)' }}>Couldn&rsquo;t load this template</p>
      <p style={{ fontSize: '0.85rem', color: 'var(--muted-foreground)', marginBottom: 16 }}>It may have been deleted, or it isn&rsquo;t yours.</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <button className="btn btn-secondary" onClick={() => refetch()}><RotateCw size={14} /> Retry</button>
        <button className="btn btn-primary" onClick={() => navigate('/documents/templates/mine')}>My templates</button>
      </div>
    </div>;
  }
  // Keyed so switching template id remounts with fresh editor content.
  return <EditorSurface key={template.id} template={template} />;
}

function EditorSurface({ template }: { template: TemplateDetail }) {
  const navigate = useNavigate();
  const updateTemplate = useUpdateTemplate();
  const publishTemplate = usePublishTemplate();
  const { data: issues = [], isFetching: checking } = usePublishCheck(template.id);

  const [stage, setStage] = useState(0);
  const [maxStage, setMaxStage] = useState(0);

  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description || '');
  const [category, setCategory] = useState(template.category || '');
  const [tags, setTags] = useState((template.tags || []).join(', '));
  const [fields, setFields] = useState<TemplateField[]>(template.fields);
  const [scan, setScan] = useState<ScanResult>({ occurrences: [], uniqueKeys: [], blankCount: 0 });
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [publishError, setPublishError] = useState('');
  const [wordCount, setWordCount] = useState(0);
  // FR-6.2 — opt-in page view, sized from the template's own page settings.
  // FR-6.1 Layout tab — held in state so the canvas re-sizes as soon as it
  // is changed, and written back with the next autosave.
  const [page, setPage] = useState(() => readPageSettings(template.page_settings));
  // FR-6.6 — authored header/footer. `touched` matters: a template that has
  // never opened the panel must keep inheriting the derived title/reference/
  // date rather than have four empty strings saved over them.
  const [furniture, setFurniture] = useState(() => readPageFurniture(template.page_settings));
  const [furnitureTouched, setFurnitureTouched] = useState(
    () => hasAuthoredFurniture(template.page_settings),
  );
  const [paged, setPaged] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [tryIt, setTryIt] = useState(false);

  // D5 — the assistant panel, opened from the toolbar or by typing "/ai".
  const [aiOpen, setAiOpen] = useState(false);
  // D1 — result of the rule-based "Detect blanks" run.
  const [detectNote, setDetectNote] = useState('');
  /**
   * Plain "___" runs still sitting in the text as literal underscores.
   *
   * Recomputed when the text changes rather than on every render: the
   * editor re-renders on each keystroke, and getText() walks the whole
   * document.
   */
  const [plainRuns, setPlainRuns] = useState(0);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({
    name, description, category, tags, fields, scan, page, furniture, furnitureTouched,
  });
  const editorRef = useRef<Editor | null>(null);
  // The editor is built once, so the slash command calls through a ref
  // rather than closing over the first render's state.
  const slashAIRef = useRef<() => boolean>(() => false);
  // FR-10.1 — inline completion. `ghostRef` is read by the plugin on
  // every tick, so flipping the switch takes effect without rebuilding
  // the editor (which would lose the undo history).
  const ghostRef = useRef<{ enabled: boolean; fetch: (b: string) => Promise<string> }>({
    enabled: false,
    fetch: async () => '',
  });

  /**
   * Text on either side of a question's FIRST blank, for AI field suggestion
   * (FR-8.4). Only the immediate neighbourhood is returned — the model needs
   * the sentence the blank sits in, not the document, and sending less is
   * both cheaper and less exposure of a confidential body.
   */
  const getFieldContext = useCallback((key: string) => {
    const ed = editorRef.current;
    if (!ed) return null;
    let pos: number | null = null;
    ed.state.doc.descendants((node, at) => {
      if (pos !== null) return false;
      if (node.type.name === PLACEHOLDER_NODE && node.attrs.fieldKey === key) {
        pos = at;
        return false;
      }
      return true;
    });
    if (pos === null) return null;
    const WINDOW = 400;
    const size = ed.state.doc.content.size;
    return {
      before: ed.state.doc.textBetween(Math.max(0, pos - WINDOW), pos, ' '),
      after: ed.state.doc.textBetween(
        Math.min(size, pos + 1), Math.min(size, pos + 1 + WINDOW), ' ',
      ),
    };
  }, []);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: createExtensions({
      onSlashAI: () => slashAIRef.current(),
      ghost: {
        enabled: true,  // the ref below is the real switch
        fetchSuggestion: (before) =>
          (ghostRef.current.enabled ? ghostRef.current.fetch(before) : Promise.resolve('')),
      },
    }),
    content: isEmptyContent(template.content) ? EMPTY_DOC : (template.content as object),
    // FR-6.4 — strip Word's presentation markup on paste; keep the structure.
    editorProps: {
      ...pasteProps,
      // FR-6.4 native spell-check. Browsers default this on for
      // contenteditable, but stating it means a future editorProps change
      // cannot silently turn it off.
      attributes: { 'aria-label': 'Template content', spellcheck: 'true' },
    },
    onUpdate: ({ editor: ed }) => {
      setScan(scanPlaceholders(ed));
      setWordCount(countWords(ed));
      setPlainRuns(countBlankRuns(ed.getText()));
      scheduleSave();
    },
  });
  editorRef.current = editor;

  // Initial scan once the editor exists.
  useEffect(() => {
    if (!editor) return;
    setScan(scanPlaceholders(editor));
    setWordCount(countWords(editor));
    setPlainRuns(countBlankRuns(editor.getText()));
  }, [editor]);

  // Reconcile the field list with the blanks actually in the document:
  // new keys get a default definition, removed keys drop their config (FR-7.9).
  useEffect(() => {
    setFields((prev) => {
      const byKey = new Map(prev.map((f) => [f.key, f]));
      const next = scan.uniqueKeys.map((key, i) => {
        const existing = byKey.get(key);
        return existing
          ? { ...existing, order_index: i }
          : { key, label: '', type: 'text', required: false, order_index: i };
      });
      const same = next.length === prev.length && next.every((f, i) =>
        f.key === prev[i]?.key && f.order_index === prev[i]?.order_index);
      return same ? prev : next;
    });
  }, [scan.uniqueKeys]);

  // Keep a valid selection as blanks come and go.
  useEffect(() => {
    if (fields.length === 0) { setActiveKey(null); return; }
    if (!activeKey || !fields.some((f) => f.key === activeKey)) setActiveKey(fields[0].key);
  }, [fields, activeKey]);

  useEffect(() => {
    latest.current = {
      name, description, category, tags, fields, scan, page, furniture, furnitureTouched,
    };
  }, [name, description, category, tags, fields, scan, page, furniture, furnitureTouched]);

  const doSave = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    setSaveState('saving');
    try {
      const l = latest.current;
      await updateTemplate.mutateAsync({
        id: template.id,
        data: {
          name: l.name.trim() || 'Untitled template',
          description: l.description || null,
          category: l.category || null,
          tags: l.tags.split(',').map((t) => t.trim()).filter(Boolean),
          content: ed.getJSON() as Record<string, unknown>,
          page_settings: {
            size: l.page.size,
            orientation: l.page.orientation,
            // Only sent once the author has actually set something, so an
            // untouched template keeps inheriting its derived furniture.
            ...(l.furnitureTouched ? l.furniture : {}),
          },
          fields: l.fields,
          placeholders: l.scan.occurrences,
        },
      });
      setSaveState('saved');
      setLastSavedAt(new Date());
    } catch {
      setSaveState('error');
    }
  }, [template.id, updateTemplate]);

  const scheduleSave = useCallback(() => {
    setSaveState('unsaved');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void doSave(); }, AUTOSAVE_MS);
  }, [doSave]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // ── placeholder-node operations ───────────────────────────────────────────

  /** Rewrite attributes on matching placeholder nodes in one history-free tx. */
  const patchNodes = useCallback((
    match: (attrs: Record<string, unknown>) => boolean,
    patch: (attrs: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const ed = editorRef.current;
    if (!ed) return;
    const updates: { pos: number; attrs: Record<string, unknown> }[] = [];
    ed.state.doc.descendants((node, pos) => {
      if (node.type.name === PLACEHOLDER_NODE && match(node.attrs)) {
        updates.push({ pos, attrs: patch(node.attrs) });
      }
    });
    if (!updates.length) return;
    const tr = ed.state.tr;
    updates.forEach((u) => tr.setNodeMarkup(u.pos, undefined, u.attrs));
    ed.view.dispatch(tr.setMeta('addToHistory', false));
    setScan(scanPlaceholders(ed));
  }, []);

  /** Push a field's question text onto every blank sharing its key (FR-7.4). */
  const applyLabelToNodes = useCallback((fieldKey: string, label: string) => {
    patchNodes((a) => a.fieldKey === fieldKey, (a) => ({ ...a, label }));
  }, [patchNodes]);

  const setField = (key: string, patch: Partial<TemplateField>) => {
    setFields((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));
    if (patch.label !== undefined) applyLabelToNodes(key, patch.label);
    scheduleSave();
  };

  // FR-6.6 — Ctrl/Cmd+F opens find & replace inside the editor rather than
  // the browser's own find, which cannot replace or see ProseMirror state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && stage === 0) {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage]);

  /**
   * FR-8.6 — apply a new question order / section assignment.
   *
   * Written as one state update so a drag produces a single autosave rather
   * than one per field, and so the list can never be seen half-reordered.
   */
  const reorderFields = (
    updates: { key: string; order_index: number; section: string | null }[],
  ) => {
    const byKey = new Map(updates.map((u) => [u.key, u]));
    setFields((prev) => {
      const next = prev.map((f) => {
        const u = byKey.get(f.key);
        return u ? { ...f, order_index: u.order_index, section: u.section } : f;
      });
      return next.sort(
        (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.key.localeCompare(b.key),
      );
    });
    scheduleSave();
  };

  /** FR-7.4 — split one occurrence off into its own question. */
  const unlinkOccurrence = (nodeId: string) => {
    const used = new Set(scan.uniqueKeys);
    let n = used.size + 1;
    let fresh = `field_${n}`;
    while (used.has(fresh)) { n += 1; fresh = `field_${n}`; }
    patchNodes((a) => a.phId === nodeId, (a) => ({ ...a, fieldKey: fresh, label: '' }));
    setActiveKey(fresh);
    scheduleSave();
  };

  /** FR-7.4 — point one occurrence at an existing question. */
  const linkOccurrence = (nodeId: string, targetKey: string) => {
    const target = fields.find((f) => f.key === targetKey);
    patchNodes((a) => a.phId === nodeId, (a) => ({ ...a, fieldKey: targetKey, label: target?.label || '' }));
    setActiveKey(targetKey);
    scheduleSave();
  };

  const insertBlank = () => {
    editorRef.current?.chain().focus()
      .insertContent({ type: PLACEHOLDER_NODE, attrs: { phId: newPlaceholderId() } })
      .run();
  };

  // ── D1 — rule-based blank detection (no AI) ——————————————————
  const detectRules = useDetectTemplateBlanks();


  /**
   * Convert every fill-in pattern the rules can see into real blanks.
   *
   * The server does the splicing — it is the same detector the document
   * import uses, and it proves the surrounding text is unchanged (FR-9.4)
   * before returning the rewritten body.
   */
  const runRuleDetect = async () => {
    const ed = editorRef.current;
    if (!ed) return;
    setDetectNote('');
    try {
      const res = await detectRules.mutateAsync({
        id: template.id,
        content: ed.getJSON() as Record<string, unknown>,
      });
      if (res.found === 0) {
        setDetectNote('No fill-in patterns found. Type ___ where something must be filled in.');
        return;
      }
      ed.commands.setContent(res.content as never, { emitUpdate: true });
      // Carry the detector's labels and types onto the questions the scanner
      // is about to create, so they arrive named rather than as "field_1".
      const byKey = new Map(res.fields.map((f) => [f.key, f]));
      setFields((prev) => prev.map((f) => {
        const hit = byKey.get(f.key);
        return hit && !f.label ? { ...f, label: hit.label, type: hit.type } : f;
      }));
      const skipped = res.skipped.length
        ? ` ${res.skipped.length} couldn't be converted without changing the text — add those by hand.`
        : '';
      setDetectNote(`Added ${res.found} blank${res.found === 1 ? '' : 's'}.${skipped}`);
      scheduleSave();
    } catch (err) {
      setDetectNote(err instanceof Error ? err.message : 'Could not detect blanks.');
    }
  };

  /** D5 — the paragraph the cursor is in, and nothing more. */
  const aiContext = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return '';
    const { $from } = ed.state.selection;
    return $from.parent.textContent.slice(0, 1500);
  }, []);

  const insertAIDraft = (text: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    // Inserted as plain paragraphs: the reply is text, and routing it through
    // insertContent as HTML would let a stray tag into the body. Any "___"
    // it wrote is picked up by the editor's own rules.
    ed.chain().focus().insertContent(
      text.split(/\n{2,}/).map((para) => ({
        type: 'paragraph',
        content: para.trim() ? [{ type: 'text', text: para.trim() }] : [],
      })),
    ).run();
    scheduleSave();
  };

  // ── AI blank detection (FR-9.3/9.4) ─────────────────────────────────────
  const ai = useAIAvailability();
  // FR-10.1 — inline completion. Off by default; the hook owns the
  // remembered preference, this page only keeps the plugin's ref in step.
  const ghost = useGhostText({ available: !!ai.enabled, templateId: template.id });
  ghostRef.current = { enabled: ghost.config.enabled, fetch: ghost.config.fetchSuggestion };
  // Assigned every render so "/ai" reflects the CURRENT availability: the
  // editor is built once, and availability arrives a moment later.
  slashAIRef.current = () => {
    if (!ai.enabled) return false;
    setAiOpen(true);
    return true;
  };
  const detect = useDetectBlanks();
  const recordAIDecision = useAIDecision();
  const [detectOpen, setDetectOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);

  const runDetect = () => {
    const ed = editorRef.current;
    if (!ed) return;
    setDetectOpen(true);
    detect.mutate({ document_text: ed.getText(), template_id: template.id });
  };

  /**
   * Turn the chosen snippets into real placeholder nodes.
   *
   * Applied as ONE transaction, scanning from the end of the document
   * backwards: replacing text shifts every position after it, so working
   * forwards would invalidate the positions still to be used.
   */
  const applyDetected = (chosen: DetectedBlank[]) => {
    const ed = editorRef.current;
    if (!ed || chosen.length === 0) return;

    type Hit = { from: number; to: number; blank: DetectedBlank };
    const hits: Hit[] = [];
    const claimed: Array<[number, number]> = [];

    ed.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return true;
      for (const blank of chosen) {
        let at = node.text.indexOf(blank.snippet);
        while (at !== -1) {
          const from = pos + at;
          const to = from + blank.snippet.length;
          // One snippet may be a substring of another; never let two blanks
          // claim overlapping text.
          const overlaps = claimed.some(([cf, ct]) => from < ct && to > cf);
          if (!overlaps) {
            claimed.push([from, to]);
            hits.push({ from, to, blank });
            break;          // first occurrence of each snippet only
          }
          at = node.text.indexOf(blank.snippet, at + 1);
        }
      }
      return true;
    });

    if (hits.length === 0) return;
    hits.sort((a, b) => b.from - a.from);

    const chain = ed.chain().focus();
    for (const hit of hits) {
      chain.insertContentAt({ from: hit.from, to: hit.to }, {
        type: PLACEHOLDER_NODE,
        attrs: {
          phId: newPlaceholderId(),
          fieldKey: hit.blank.key,
          label: hit.blank.label,
        },
      });
    }
    chain.run();

    // Carry the model's labels and types onto the fields the scanner creates.
    setFields((prev) => {
      const byKey = new Map(prev.map((f) => [f.key, f]));
      for (const b of chosen) {
        const existing = byKey.get(b.key);
        if (existing) byKey.set(b.key, { ...existing, label: b.label, type: b.type });
      }
      return [...byKey.values()];
    });

    recordAIDecision(detect.data?.interaction_id, true);
    setDetectOpen(false);
    detect.reset();
    scheduleSave();
  };

  const dismissDetect = () => {
    recordAIDecision(detect.data?.interaction_id, false);
    setDetectOpen(false);
    detect.reset();
  };

  /** Scroll one specific blank into view and flash it. */
  const focusOccurrence = (nodeId: string) => {
    const el = document.querySelector<HTMLElement>(`.ph-blank[data-ph-id="${CSS.escape(nodeId)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ph-active');
    setTimeout(() => el.classList.remove('ph-active'), 1200);
  };

  /** Jump to a field's question from the publish checklist / left pane. */
  const focusField = (fieldKey: string) => {
    setActiveKey(fieldKey);
    if (stage === 0) setStage(1);
  };

  // ── stage navigation ──────────────────────────────────────────────────────
  const goStage = (i: number) => {
    const next = Math.max(0, Math.min(STAGES.length - 1, i));
    setStage(next);
    setMaxStage((m) => Math.max(m, next));
  };

  const localIssues = useMemo(() => fields.filter((f) => fieldIssue(f)), [fields]);
  const ready = issues.length === 0 && scan.blankCount > 0 && localIssues.length === 0;

  const sampleAnswers = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of fields) out[f.key] = sampleAnswer(f);
    return out;
  }, [fields]);

  const previewContent = editor?.getJSON() ?? EMPTY_DOC;

  const handlePublish = async () => {
    setPublishError('');
    if (timer.current) clearTimeout(timer.current);
    await doSave();                       // publish-check reads saved state
    try {
      await publishTemplate.mutateAsync({
        id: template.id,
        data: {
          name: name.trim(),
          description: description || null,
          category: category || null,
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        },
      });
      navigate('/documents/templates/mine', { state: { published: template.id } });
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Could not publish this template.');
    }
  };

  return (
    <div className="page-content" style={{ paddingTop: 24, maxWidth: 1320, margin: '0 auto' }}>
      <button onClick={() => navigate('/documents/templates/mine')} className="btn btn-ghost btn-sm" style={{ marginBottom: 12, paddingLeft: 0 }}>← My templates</button>
      <PageHeader
        breadcrumbs={[{ label: 'Documents' }, { label: 'Templates' }, { label: 'Edit' }]}
        title="Template editor"
        description="Write your document and mark the blanks. Each unique blank becomes one question."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <SaveIndicator state={saveState} lastSavedAt={lastSavedAt} onRetry={() => void doSave()} />
            {stage < STAGES.length - 1 ? (
              <button className="btn btn-primary" onClick={() => goStage(stage + 1)}>
                {stage === 0 ? 'Configure questions →' : 'Preview →'}
              </button>
            ) : (
              <button className="btn btn-primary" disabled={!ready || publishTemplate.isPending || checking} onClick={handlePublish}>
                <Rocket size={15} /> {publishTemplate.isPending ? 'Publishing…' : 'Create template'}
              </button>
            )}
          </div>
        }
      />
      <div style={{ height: 16 }} />

      <div style={{ padding: '14px 18px', background: 'var(--card-solid)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', marginBottom: 18 }}>
        <Stepper steps={STAGES} current={stage} maxReached={maxStage} onStepClick={goStage} />
      </div>

      {/* ── Stage 1: Write ── */}
      {stage === 0 && (
        <>
          <input
            className="input" value={name} aria-label="Template name"
            onChange={(e) => { setName(e.target.value); scheduleSave(); }}
            placeholder="Template name"
            style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: 14, maxWidth: 520 }}
          />
          <EditorToolbar
            editor={editor}
            onInsertBlank={insertBlank}
            pageSize={page.size}
            pageOrientation={page.orientation}
            onPageSettingsChange={(next) => { setPage(next); scheduleSave(); }}
            furniture={furniture}
            onFurnitureChange={(next) => {
              setFurniture(next);
              setFurnitureTouched(true);
              scheduleSave();
            }}
            paged={paged}
            onPagedChange={setPaged}
            outlineOpen={outlineOpen}
            onOutlineToggle={() => setOutlineOpen((o) => !o)}
            onFind={() => setFindOpen(true)}
          />
          <FindReplaceBar editor={editor} open={findOpen} onClose={() => setFindOpen(false)} />
          {/* D3 — the instruction, where the author is actually looking. */}
          <EditorTipBar />
          <div style={{
            display: 'grid', gap: 16, alignItems: 'start',
            gridTemplateColumns: [
              'minmax(0, 1fr)',
              outlineOpen ? '220px' : '',
              aiOpen ? '300px' : '',
            ].filter(Boolean).join(' '),
          }}>
            <PagedCanvas
              enabled={paged}
              onPageCountChange={setPageCount}
              size={page.size}
              orientation={page.orientation}
            >
              <EditorContent editor={editor} />
            </PagedCanvas>
            {outlineOpen && (
              <div style={{ position: 'sticky', top: 72 }}>
                <OutlinePane editor={editor} compact />
              </div>
            )}
            {aiOpen && (
              <div style={{ position: 'sticky', top: 72 }}>
                <AIAssistantPanel
                  open={aiOpen}
                  onClose={() => setAiOpen(false)}
                  onInsert={insertAIDraft}
                  getContext={aiContext}
                  templateId={template.id}
                />
              </div>
            )}
          </div>

          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {/* D1 — rule-based, so it is offered whether or not AI is on. */}
            <button type="button" onClick={runRuleDetect} disabled={detectRules.isPending}
              className="btn btn-secondary btn-sm">
              <ScanLine size={14} /> {detectRules.isPending ? 'Looking…' : 'Detect blanks'}
            </button>
            {ai.enabled && (
              <>
                <button type="button" onClick={() => setAiOpen(true)} aria-pressed={aiOpen}
                  className="btn btn-ghost btn-sm">
                  <Sparkles size={14} /> Write with AI
                </button>
                <button type="button" onClick={runDetect} disabled={detect.isPending}
                  className="btn btn-ghost btn-sm">
                  <Sparkles size={14} /> Find blanks with AI
                </button>
                <button
                  type="button"
                  onClick={ghost.toggle}
                  aria-pressed={ghost.on}
                  className="btn btn-ghost btn-sm"
                  title={ghost.on
                    ? 'Stop suggesting the next few words as you type'
                    : 'Suggest the next few words as you type. Press Tab to accept.'}
                >
                  {ghost.on ? <Lightbulb size={14} /> : <LightbulbOff size={14} />}
                  {ghost.on ? 'Suggestions on' : 'Suggest as I type'}
                </button>
              </>
            )}
          </div>
          {detectNote && (
            <p role="status" style={{
              margin: '8px 0 0', fontSize: '0.8rem', color: 'var(--muted-foreground)',
            }}>{detectNote}</p>
          )}

          <AIBlankDetectPanel
            open={detectOpen}
            loading={detect.isPending}
            error={detect.isError
              ? (detect.error instanceof Error ? detect.error.message : 'AI assistance is unavailable right now.')
              : null}
            blanks={detect.data?.blanks ?? []}
            truncated={detect.data?.truncated ?? false}
            onApply={applyDetected}
            onDismiss={dismissDetect}
            onRetry={runDetect}
          />
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 10, padding: '8px 4px',
            fontSize: '0.78rem', color: 'var(--muted-foreground)',
          }}>
            <span>{wordCount} word{wordCount === 1 ? '' : 's'}</span>
            {paged && (
              <span title="Approximate: the exported PDF decides the final page breaks.">
                {pageCount} page{pageCount === 1 ? '' : 's'} (approx.)
              </span>
            )}
            <span>{blanksSummary(scan)}</span>
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
            <button type="button" onClick={() => setFindOpen(true)}
              className="btn btn-ghost btn-sm" style={{ fontSize: '0.76rem', padding: '2px 8px' }}>
              Find & replace (Ctrl+F)
            </button>
            {plainRuns > 0 && (
              <span style={{ marginLeft: 'auto', color: 'var(--status-pending-fg)' }}>
                {plainRuns} plain <code>___</code> run{plainRuns === 1 ? '' : 's'} not yet a blank — press “Detect blanks”
              </span>
            )}
          </div>
        </>
      )}

      {/* ── Stage 2: Configure questions (split view, FR-8.2) ── */}
      {stage === 1 && scan.blankCount === 0 && (
        <div style={{
          padding: '16px 18px', marginBottom: 16, borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border)', background: 'var(--card-solid)',
          display: 'grid', gap: 10, justifyItems: 'start',
        }}>
          <p style={{ margin: 0, fontSize: '0.92rem', fontWeight: 700, color: 'var(--foreground)' }}>
            No questions yet
          </p>
          {plainRuns > 0 ? (
            <>
              {/* D2 — the document is visibly full of blanks; saying
                  "none found" and stopping there is the bug. */}
              <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--muted-foreground)' }}>
                Found {plainRuns} possible blank{plainRuns === 1 ? '' : 's'} written as
                plain underscores. Convert them into questions?
              </p>
              <button type="button" className="btn btn-primary btn-sm"
                disabled={detectRules.isPending}
                onClick={async () => { await runRuleDetect(); }}>
                <ScanLine size={14} />
                {detectRules.isPending
                  ? 'Converting…'
                  : `Convert ${plainRuns} blank${plainRuns === 1 ? '' : 's'}`}
              </button>
            </>
          ) : (
            <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--muted-foreground)' }}>
              Go back to Write and type <code>___</code> wherever someone must fill
              something in. Each unique blank becomes one question here.
            </p>
          )}
          {detectNote && (
            <p role="status" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
              {detectNote}
            </p>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => goStage(0)}>
            ← Back to Write
          </button>
        </div>
      )}
      {stage === 1 && (
        <SplitPane
          storageKey="template-configure"
          stackedLeftLabel="Document"
          leftLabel="Document" rightLabel="Questions"
          left={
            <DocumentPreview
              content={previewContent}
              activeFieldKey={activeKey}
              onBlankClick={(key) => setActiveKey(key)}
            />
          }
          right={
            <FieldConfigPanel
              fields={fields}
              occurrences={scan.occurrences}
              activeKey={activeKey}
              onActiveKeyChange={setActiveKey}
              onPatch={setField}
              onUnlinkOccurrence={unlinkOccurrence}
              onLinkOccurrence={linkOccurrence}
              onFocusOccurrence={focusOccurrence}
              showAdvanced={showAdvanced}
              onToggleAdvanced={() => setShowAdvanced((s) => !s)}
              getFieldContext={getFieldContext}
              templateId={template.id}
              onReorderFields={reorderFields}
            />
          }
        />
      )}

      {/* ── Stage 3: Preview & publish (FR-11.1/11.2/11.3) ── */}
      {stage === 2 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 20, alignItems: 'start' }}>
          <div>
            <div role="group" aria-label="Preview mode" style={{ display: 'flex', gap: 2, marginBottom: 12 }}>
              {[{ v: false, l: 'Blank mode' }, { v: true, l: 'Try it (sample data)' }].map((m) => (
                <button key={m.l} onClick={() => setTryIt(m.v)} aria-pressed={tryIt === m.v} style={{
                  padding: '7px 14px', fontSize: '0.82rem', fontWeight: tryIt === m.v ? 700 : 500,
                  borderRadius: 'var(--radius-pill)', border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                  background: tryIt === m.v ? 'var(--secondary)' : 'transparent',
                  color: tryIt === m.v ? 'var(--secondary-foreground)' : 'var(--muted-foreground)',
                }}>{m.l}</button>
              ))}
            </div>
            <DocumentPreview
              content={previewContent}
              answers={tryIt ? sampleAnswers : undefined}
              plain={tryIt}
            />
            {tryIt && (
              <p style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', marginTop: 8 }}>
                Sample values, shown only here so you can judge the finished look. Nothing is saved.
              </p>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, position: 'sticky', top: 8 }}>
            {/* Metadata (FR-11.3) */}
            <section style={sectionStyle}>
              <h3 style={h3Style}>Template details</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <label style={smallLabel} htmlFor="tpl-name">Name <span style={{ color: 'var(--status-rejected)' }} aria-hidden>*</span></label>
                  <input id="tpl-name" className="input" value={name}
                    onChange={(e) => { setName(e.target.value); scheduleSave(); }} />
                </div>
                <div>
                  <label style={smallLabel} htmlFor="tpl-desc">Description</label>
                  <textarea id="tpl-desc" className="input" rows={3} value={description} style={{ resize: 'vertical' }}
                    placeholder="What is this template for?"
                    onChange={(e) => { setDescription(e.target.value); scheduleSave(); }} />
                </div>
                <div>
                  <label style={smallLabel} htmlFor="tpl-cat">Category</label>
                  <input id="tpl-cat" className="input" value={category} placeholder="e.g. Contracts"
                    onChange={(e) => { setCategory(e.target.value); scheduleSave(); }} />
                </div>
                <div>
                  <label style={smallLabel} htmlFor="tpl-tags">Tags (comma-separated)</label>
                  <input id="tpl-tags" className="input" value={tags} placeholder="e.g. legal, nda"
                    onChange={(e) => { setTags(e.target.value); scheduleSave(); }} />
                </div>
              </div>
            </section>

            {/* Publish checklist (FR-11.2) */}
            <section style={sectionStyle}>
              <h3 style={h3Style}>Before you publish</h3>
              {checking ? (
                <p style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>Checking…</p>
              ) : ready ? (
                <p style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.84rem', color: 'var(--status-approved)', fontWeight: 600 }}>
                  <CheckCircle2 size={15} /> Ready to publish
                </p>
              ) : (
                <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, listStyle: 'none', margin: 0, padding: 0 }}>
                  {scan.blankCount === 0 && (
                    <li style={{ display: 'flex', gap: 8, fontSize: '0.82rem', color: 'var(--status-pending)' }}>
                      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                      Add at least one blank.
                    </li>
                  )}
                  {/* Local, live issues first — these update as you type. */}
                  {localIssues.map((f) => (
                    <li key={`local-${f.key}`}>
                      <button onClick={() => focusField(f.key)} style={issueButton}>
                        <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                        <span>{fieldIssue(f)} — {f.label || f.key}</span>
                      </button>
                    </li>
                  ))}
                  {/* Server-side rules the client can't see (duplicate keys etc.). */}
                  {issues.filter((it) => !localIssues.some((f) => f.key === it.field_key)).map((it, i) => (
                    <li key={`srv-${i}`}>
                      <button onClick={() => it.field_key && focusField(it.field_key)}
                        style={{ ...issueButton, cursor: it.field_key ? 'pointer' : 'default' }}>
                        <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                        <span>{it.message}{it.field_key ? ` (${it.field_key})` : ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {publishError && (
                <p role="alert" style={{ marginTop: 10, fontSize: '0.8rem', color: 'var(--status-rejected)', fontWeight: 600 }}>{publishError}</p>
              )}
            </section>

            {/* FR-14.8 — version history and restore. */}
            <section style={sectionStyle}>
              <TemplateVersionHistory templateId={template.id} />
            </section>
          </div>
        </div>
      )}
      <div style={{ height: 40 }} />
    </div>
  );
}

const sectionStyle: React.CSSProperties = {
  background: 'var(--card-solid)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)', padding: 16,
};
const h3Style: React.CSSProperties = {
  fontSize: '0.95rem', fontWeight: 700, color: 'var(--foreground)', marginBottom: 10,
};
const smallLabel: React.CSSProperties = {
  display: 'block', fontSize: '0.76rem', fontWeight: 700, color: 'var(--muted-foreground)', marginBottom: 5,
};
const issueButton: React.CSSProperties = {
  display: 'flex', gap: 8, textAlign: 'left', background: 'none', border: 'none',
  padding: 0, cursor: 'pointer', fontSize: '0.82rem', color: 'var(--status-pending)',
  fontFamily: 'var(--font-sans)',
};
