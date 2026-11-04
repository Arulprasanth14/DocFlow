/**
 * DocFlow — the editor ribbon (spec §8.6 FR-6.1).
 *
 * Four tabs, as the spec describes: Home (text and paragraph formatting),
 * Insert (tables, images, rules, blanks), Layout (page size and orientation,
 * which the PDF renderer reads back), View (page view, outline, find).
 *
 * Tabs rather than one long row because the row had outgrown a phone screen
 * twice over; grouping also makes the less-used controls findable instead of
 * absent. Layout and View appear only when the host page passes the state
 * they act on, so the freeform document editor does not show a Layout tab for
 * settings it has nowhere to store.
 *
 * Marks come from @tiptap/starter-kit (Link and Underline ship with it in
 * v3), tables from @tiptap/extension-table, colour/highlight/alignment/size
 * from the text-style family, and line spacing and indentation from our own
 * BlockFormat. Every one of those is mirrored in the server's
 * `content_sanitizer`; a mark added here and not there is stripped on save.
 *
 * An inserted image is uploaded first and referenced by FileAsset id — the
 * editor never puts a URL into the document.
 */
import { useCallback, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight,
  Bold, Code, Columns3, Combine, Heading1, Heading2, Heading3,
  Highlighter, ImagePlus, IndentDecrease, IndentIncrease,
  Italic, Link as LinkIcon, List, ListOrdered, Loader2, Minus, Quote,
  RemoveFormatting, Rows3, Search, Split, SquareDashedBottom, Strikethrough,
  Table as TableIcon, Trash2, Underline, Undo2, Redo2, Unlink,
  Baseline, Sparkles, PanelLeft, FileText, PanelTop, ChevronDown,
} from 'lucide-react';
import { filesApi } from '@/lib/api/files';
import { useAIAvailability, useAIRewrite, useAIDecision } from '@/hooks/useAI';
import { aiApi, type RewriteSuggestion } from '@/lib/api/ai';
import { AIRewriteDialog } from '@/components/ai/AIRewriteDialog';
import { AISelectionMenu } from '@/components/ai/AISelectionMenu';
import { LINE_HEIGHTS } from './BlockFormat';
import type { PageFurnitureValue, PageOrientation, PageSize } from './PagedCanvas';
import { EMPTY_FURNITURE } from './PagedCanvas';

/** What each header/footer field falls back to when it is left empty (FR-6.6). */
const FURNITURE_PLACEHOLDERS: Record<string, string> = {
  header_left: 'Document title',
  header_right: 'Reference number',
  footer_left: 'Submitted date',
  footer_right: 'Page {page} of {pages}',
};

/** Matches the server's image allow-list; SVG is excluded — it can script. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const TABS = ['Home', 'Insert', 'Layout', 'View'] as const;
type Tab = (typeof TABS)[number];

/**
 * Text and highlight colours.
 *
 * Deliberately a short, fixed palette rather than a colour picker: these
 * values are written into the document, read back by the PDF renderer and
 * validated by the server, and a free-form picker invites both unreadable
 * combinations and values the sanitiser will silently drop. Hex literals are
 * correct here — they are document CONTENT chosen by the author, not theme
 * colours, and must look the same in light mode, dark mode and the PDF.
 */
const TEXT_COLORS: { value: string; label: string }[] = [
  { value: '#111827', label: 'Black' },
  { value: '#6b7280', label: 'Grey' },
  { value: '#b91c1c', label: 'Red' },
  { value: '#b45309', label: 'Amber' },
  { value: '#15803d', label: 'Green' },
  { value: '#1d4ed8', label: 'Blue' },
  { value: '#6d28d9', label: 'Violet' },
];

const HIGHLIGHTS: { value: string; label: string }[] = [
  { value: '#fef08a', label: 'Yellow' },
  { value: '#bbf7d0', label: 'Green' },
  { value: '#bfdbfe', label: 'Blue' },
  { value: '#fbcfe8', label: 'Pink' },
  { value: '#e5e7eb', label: 'Grey' },
];

const FONT_SIZES = ['10px', '12px', '14px', '16px', '18px', '24px', '32px'];

/**
 * A 30px square is below the 44px recommended touch target, so on a
 * coarse pointer the buttons grow (FR-15.6 / FR-8.7). Done with a class
 * rather than inline styles because a media query cannot be inlined.
 */
function TB({ onClick, active, disabled, label, children }: {
  onClick: () => void; active?: boolean; disabled?: boolean; label: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button" onClick={onClick} title={label} aria-label={label} aria-pressed={!!active}
      disabled={disabled} className="ribbon-btn"
      style={{
        background: active ? 'var(--secondary)' : 'transparent',
        color: active ? 'var(--secondary-foreground)' : 'var(--muted-foreground)',
      }}
    >{children}</button>
  );
}

const Divider = () => (
  <span aria-hidden style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
);

const selectStyle: React.CSSProperties = {
  height: 30, padding: '0 6px', fontSize: '0.78rem', fontFamily: 'var(--font-sans)',
  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--card-solid)', color: 'var(--foreground)', cursor: 'pointer',
};

/** Only http(s)/mailto links are offered; the server drops anything else. */
function normaliseUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  if (/^[\w.-]+@[\w.-]+\.\w+$/.test(url)) return `mailto:${url}`;
  if (/^[./#]/.test(url)) return url;
  return `https://${url}`;
}

/** A row of swatches, used for both text colour and highlight. */
function Swatches({ options, onPick, onClear, label, current }: {
  options: { value: string; label: string }[];
  onPick: (value: string) => void;
  onClear: () => void;
  label: string;
  current?: string;
}) {
  return (
    <span role="group" aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      {options.map((c) => (
        <button
          key={c.value} type="button" onClick={() => onPick(c.value)}
          title={`${label}: ${c.label}`} aria-label={`${label}: ${c.label}`}
          aria-pressed={current === c.value}
          className="ribbon-swatch"
          style={{
            background: c.value,
            outline: current === c.value ? '2px solid var(--primary)' : 'none',
            outlineOffset: 1,
          }}
        />
      ))}
      <button
        type="button" onClick={onClear} title={`Remove ${label.toLowerCase()}`}
        aria-label={`Remove ${label.toLowerCase()}`} className="ribbon-btn"
        style={{ background: 'transparent', color: 'var(--muted-foreground)' }}
      ><RemoveFormatting size={13} /></button>
    </span>
  );
}

export interface EditorToolbarProps {
  editor: Editor | null;
  /** Omit for freeform documents — only templates have blanks. */
  onInsertBlank?: () => void;
  /** Attributes AI rewrites to a document in the audit trail. */
  documentId?: string | null;
  /** Layout tab. Omitted together, the tab is not shown. */
  pageSize?: PageSize;
  pageOrientation?: PageOrientation;
  onPageSettingsChange?: (next: { size: PageSize; orientation: PageOrientation }) => void;
  /** FR-6.6 — authored header/footer. Omit `onFurnitureChange` to hide it. */
  furniture?: PageFurnitureValue;
  onFurnitureChange?: (next: PageFurnitureValue) => void;
  /** View tab. Omitted together, the tab is not shown. */
  paged?: boolean;
  onPagedChange?: (next: boolean) => void;
  outlineOpen?: boolean;
  onOutlineToggle?: () => void;
  onFind?: () => void;
}

export function EditorToolbar({
  editor, onInsertBlank, documentId,
  pageSize, pageOrientation, onPageSettingsChange,
  furniture, onFurnitureChange,
  paged, onPagedChange, outlineOpen, onOutlineToggle, onFind,
}: EditorToolbarProps) {
  const [tab, setTab] = useState<Tab>('Home');
  /** FR-6.6 — the header/footer fields are a row of their own, revealed on
   *  demand: five inputs would otherwise crowd every other Layout control. */
  const [furnitureOpen, setFurnitureOpen] = useState(false);

  const hasLayout = !!onPageSettingsChange;
  const hasView = !!onPagedChange || !!onOutlineToggle || !!onFind;
  const tabs = TABS.filter((t) =>
    (t !== 'Layout' || hasLayout) && (t !== 'View' || hasView));

  const setLink = useCallback(() => {
    if (!editor) return;
    const existing = (editor.getAttributes('link').href as string) || '';
    // eslint-disable-next-line no-alert
    const input = window.prompt('Link address', existing);
    if (input === null) return;                     // cancelled
    if (input.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    const href = normaliseUrl(input);
    if (!href) return;
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  }, [editor]);

  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  /**
   * Upload first, then insert the id. If the upload fails nothing is inserted,
   * so the document can never hold a reference to an image that isn't there.
   */
  const onPickImage = useCallback(async (file: File | undefined) => {
    if (!file || !editor) return;
    setImageError(null);
    if (!IMAGE_TYPES.includes(file.type)) {
      setImageError('Choose a PNG, JPEG, GIF or WebP image.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError('That image is larger than 10 MB.');
      return;
    }
    setUploading(true);
    try {
      const { upload_url, storage_key, bucket } = await filesApi.getUploadUrl(
        file.name, file.type, file.size,
      );
      const put = await fetch(upload_url, {
        method: 'PUT', headers: { 'Content-Type': file.type }, body: file,
      });
      if (!put.ok) throw new Error(`HTTP ${put.status}`);
      const { file_asset_id } = await filesApi.confirmUpload({
        storage_key, bucket, filename: file.name,
        mime_type: file.type, size_bytes: file.size,
      });
      editor.chain().focus().insertContent({
        type: 'image',
        attrs: { assetId: file_asset_id, alt: file.name.replace(/\.[^.]+$/, '') },
      }).run();
    } catch {
      setImageError("That image couldn't be uploaded. Try again.");
    } finally {
      setUploading(false);
    }
  }, [editor]);

  const linkActive = !!editor?.isActive('link');
  const inTable = !!editor?.isActive('table');

  // ── AI rewrite (FR-10.1-10.4) ───────────────────────────────────────────
  // Offered only when the backend says AI is on. When it is off the button is
  // absent rather than disabled: a control that can never work is noise.
  const ai = useAIAvailability();
  const rewrite = useAIRewrite();
  const recordDecision = useAIDecision();
  const [rewriteOpen, setRewriteOpen] = useState(false);
  // The selection is captured when the dialog opens, because opening it moves
  // focus out of the editor and the live selection collapses.
  const selectionRef = useRef<{ from: number; to: number } | null>(null);

  const selectedText = (() => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;
    return from === to ? '' : editor.state.doc.textBetween(from, to, ' ');
  })();

  // FR-10.1 — the floating menu's presets and the toolbar button are the same
  // call; a preset is just an instruction the author did not have to type.
  // `instructionRef` keeps the last one so Retry repeats what was asked for
  // rather than falling back to the generic rewrite.
  const instructionRef = useRef<string | undefined>(undefined);

  // FR-10.3 — streaming rewrite. `streamed` holds the finished result once the
  // server's `done` event lands; `partial` is the text accumulated so far, so
  // the dialog fills in progressively. Neither is ever applied on its own:
  // Accept still goes through acceptRewrite.
  const [streamLoading, setStreamLoading] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [streamed, setStreamed] = useState<RewriteSuggestion | null>(null);
  const [partial, setPartial] = useState('');
  const streamAbort = useRef<AbortController | null>(null);

  const resetStream = useCallback(() => {
    streamAbort.current?.abort();
    streamAbort.current = null;
    setStreamLoading(false);
    setStreamError(false);
    setStreamed(null);
    setPartial('');
  }, []);

  /**
   * What the dialog shows: the finished streamed result if we have it, else a
   * synthetic suggestion carrying the partial text (so the author watches it
   * arrive), else the non-streaming mutation's result.
   *
   * The partial stand-in is deliberately `blocked: true` — the
   * placeholder-damage check runs server-side at the end, so a half-arrived
   * rewrite must not be acceptable yet.
   */
  const activeSuggestion: RewriteSuggestion | null =
    streamed
    ?? (partial
      ? {
          interaction_id: '',
          original: selectionRef.current
            ? editor?.state.doc.textBetween(
                selectionRef.current.from, selectionRef.current.to, ' ',
              ) ?? ''
            : '',
          suggestion: partial,
          note: null,
          confidence: 'high' as RewriteSuggestion['confidence'],
          warning: null,
          blocked: true,
        }
      : rewrite.data ?? null);

  /** The id the decision belongs to, held in a ref so accept/reject do not
   *  depend on a value that is recomputed on every render. */
  const activeIdRef = useRef<string | undefined>(undefined);
  activeIdRef.current = activeSuggestion?.interaction_id || rewrite.data?.interaction_id;

  const askRewrite = useCallback((instruction?: string) => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const passage = editor.state.doc.textBetween(from, to, ' ').trim();
    if (!passage) return;
    selectionRef.current = { from, to };
    instructionRef.current = instruction;
    setRewriteOpen(true);
    resetStream();

    // Stream when we can; the mutation is the fallback for any provider or
    // proxy that cannot.
    const ac = new AbortController();
    streamAbort.current = ac;
    setStreamLoading(true);
    void aiApi
      .streamRewrite(
        { passage, instruction, document_id: documentId ?? null },
        {
          onDelta: (delta: string) => setPartial((p) => p + delta),
          onDone: (result: RewriteSuggestion) => {
            setStreamed(result);
            setPartial('');
            setStreamLoading(false);
          },
          onError: () => {
            setStreamLoading(false);
            setStreamError(true);
            setPartial('');
            // One retry, without streaming.
            rewrite.mutate({ passage, instruction, document_id: documentId ?? null });
          },
        },
        ac.signal,
      )
      .catch(() => {
        setStreamLoading(false);
        setStreamError(true);
        rewrite.mutate({ passage, instruction, document_id: documentId ?? null });
      });
  }, [editor, rewrite, documentId, resetStream]);

  const retryRewrite = useCallback(() => {
    askRewrite(instructionRef.current);
  }, [askRewrite]);

  const acceptRewrite = useCallback((text: string) => {
    const range = selectionRef.current;
    if (editor && range) {
      editor.chain().focus()
        .insertContentAt({ from: range.from, to: range.to }, text)
        .run();
    }
    recordDecision(activeIdRef.current, true);
    setRewriteOpen(false);
    rewrite.reset();
    resetStream();
  }, [editor, rewrite, recordDecision, resetStream]);

  const rejectRewrite = useCallback(() => {
    recordDecision(activeIdRef.current, false);
    setRewriteOpen(false);
    rewrite.reset();
    resetStream();
  }, [rewrite, recordDecision, resetStream]);

  // ── current block state, for the Home tab's selects ──
  const blockType = editor?.isActive('heading', { level: 1 }) ? 'h1'
    : editor?.isActive('heading', { level: 2 }) ? 'h2'
      : editor?.isActive('heading', { level: 3 }) ? 'h3'
        : editor?.isActive('blockquote') ? 'quote'
          : editor?.isActive('codeBlock') ? 'code'
            : 'p';

  const applyBlockType = (value: string) => {
    const chain = editor?.chain().focus();
    if (!chain) return;
    switch (value) {
      case 'h1': chain.setNode('heading', { level: 1 }).run(); break;
      case 'h2': chain.setNode('heading', { level: 2 }).run(); break;
      case 'h3': chain.setNode('heading', { level: 3 }).run(); break;
      case 'quote': chain.setParagraph().toggleBlockquote().run(); break;
      case 'code': chain.setNode('codeBlock').run(); break;
      default: chain.setParagraph().run();
    }
  };

  const currentSize = (editor?.getAttributes('textStyle').fontSize as string) || '';
  const currentSpacing = (editor?.getAttributes(
    editor.isActive('heading') ? 'heading' : 'paragraph',
  ).lineHeight as string) || '';
  const currentColor = (editor?.getAttributes('textStyle').color as string) || '';
  const currentHighlight = (editor?.getAttributes('highlight').color as string) || '';

  return (
    <div className="ribbon" style={{
      background: 'var(--card-solid)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', marginBottom: 12, position: 'sticky', top: 8, zIndex: 3,
    }}>
      {/* Tab strip */}
      <div role="tablist" aria-label="Ribbon" style={{
        display: 'flex', gap: 2, padding: '4px 6px 0', borderBottom: '1px solid var(--border)',
      }}>
        {tabs.map((t) => (
          <button
            key={t} type="button" role="tab" id={`ribbon-tab-${t}`}
            aria-selected={tab === t} aria-controls={`ribbon-panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            onKeyDown={(e) => {
              // Arrow keys move between tabs, as the ARIA pattern expects.
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const i = tabs.indexOf(t);
              const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
              setTab(next);
              document.getElementById(`ribbon-tab-${next}`)?.focus();
            }}
            className="ribbon-tab"
            style={{
              fontWeight: tab === t ? 700 : 500,
              color: tab === t ? 'var(--foreground)' : 'var(--muted-foreground)',
              borderBottom: `2px solid ${tab === t ? 'var(--primary)' : 'transparent'}`,
            }}
          >{t}</button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`ribbon-panel-${tab}`}
        aria-labelledby={`ribbon-tab-${tab}`}
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, padding: '8px 10px' }}
      >
        {tab === 'Home' && (
          <>
            <TB onClick={() => editor?.chain().focus().undo().run()} label="Undo"><Undo2 size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().redo().run()} label="Redo"><Redo2 size={15} /></TB>
            <Divider />

            <label className="sr-only" htmlFor="ribbon-style">Paragraph style</label>
            <select id="ribbon-style" style={{ ...selectStyle, width: 112 }} value={blockType}
              onChange={(e) => applyBlockType(e.target.value)}>
              <option value="p">Normal text</option>
              <option value="h1">Heading 1</option>
              <option value="h2">Heading 2</option>
              <option value="h3">Heading 3</option>
              <option value="quote">Quote</option>
              <option value="code">Code block</option>
            </select>

            <label className="sr-only" htmlFor="ribbon-size">Font size</label>
            <select id="ribbon-size" style={{ ...selectStyle, width: 76 }} value={currentSize}
              onChange={(e) => {
                const chain = editor?.chain().focus();
                if (!chain) return;
                if (e.target.value) chain.setMark('textStyle', { fontSize: e.target.value }).run();
                else chain.setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run();
              }}>
              <option value="">Size</option>
              {FONT_SIZES.map((s) => <option key={s} value={s}>{s.replace('px', '')}</option>)}
            </select>
            <Divider />

            <TB onClick={() => editor?.chain().focus().toggleBold().run()} active={editor?.isActive('bold')} label="Bold"><Bold size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().toggleItalic().run()} active={editor?.isActive('italic')} label="Italic"><Italic size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().toggleUnderline().run()} active={editor?.isActive('underline')} label="Underline"><Underline size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().toggleStrike().run()} active={editor?.isActive('strike')} label="Strikethrough"><Strikethrough size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().unsetAllMarks().run()} label="Clear formatting"><RemoveFormatting size={15} /></TB>
            <Divider />

            <Baseline size={14} aria-hidden style={{ color: 'var(--muted-foreground)' }} />
            <Swatches
              label="Text colour" options={TEXT_COLORS} current={currentColor}
              onPick={(v) => editor?.chain().focus().setColor(v).run()}
              onClear={() => editor?.chain().focus().unsetColor().run()}
            />
            <Divider />
            <Highlighter size={14} aria-hidden style={{ color: 'var(--muted-foreground)' }} />
            <Swatches
              label="Highlight" options={HIGHLIGHTS} current={currentHighlight}
              onPick={(v) => editor?.chain().focus().setHighlight({ color: v }).run()}
              onClear={() => editor?.chain().focus().unsetHighlight().run()}
            />
            <Divider />

            <TB onClick={() => editor?.chain().focus().setTextAlign('left').run()} active={editor?.isActive({ textAlign: 'left' })} label="Align left"><AlignLeft size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().setTextAlign('center').run()} active={editor?.isActive({ textAlign: 'center' })} label="Align centre"><AlignCenter size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().setTextAlign('right').run()} active={editor?.isActive({ textAlign: 'right' })} label="Align right"><AlignRight size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().setTextAlign('justify').run()} active={editor?.isActive({ textAlign: 'justify' })} label="Justify"><AlignJustify size={15} /></TB>
            <Divider />

            <TB onClick={() => editor?.chain().focus().toggleBulletList().run()} active={editor?.isActive('bulletList')} label="Bulleted list"><List size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().toggleOrderedList().run()} active={editor?.isActive('orderedList')} label="Numbered list"><ListOrdered size={15} /></TB>
            <TB onClick={() => editor?.commands.indentLess()} label="Decrease indent (Ctrl+[)"><IndentDecrease size={15} /></TB>
            <TB onClick={() => editor?.commands.indentMore()} label="Increase indent (Ctrl+])"><IndentIncrease size={15} /></TB>

            <label className="sr-only" htmlFor="ribbon-spacing">Line spacing</label>
            <select id="ribbon-spacing" style={{ ...selectStyle, width: 94 }} value={currentSpacing}
              onChange={(e) => editor?.commands.setLineSpacing(
                (e.target.value || null) as never,
              )}>
              <option value="">Spacing</option>
              {LINE_HEIGHTS.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
            <Divider />

            <TB onClick={setLink} active={linkActive} label={linkActive ? 'Edit link' : 'Insert link'}><LinkIcon size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().extendMarkRange('link').unsetLink().run()} disabled={!linkActive} label="Remove link"><Unlink size={15} /></TB>

            {ai.enabled && (
              <>
                <Divider />
                <TB
                  onClick={() => askRewrite()}
                  disabled={!selectedText.trim()}
                  label={selectedText.trim()
                    ? 'Rewrite the selected text with AI'
                    : 'Select some text to rewrite with AI'}
                ><Sparkles size={15} /></TB>
              </>
            )}
          </>
        )}

        {tab === 'Insert' && (
          <>
            <TB
              onClick={() => editor?.chain().focus()
                .insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
              label="Insert table"
            ><TableIcon size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().addRowAfter().run()}
              disabled={!inTable} label="Add row below"><Rows3 size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().addColumnAfter().run()}
              disabled={!inTable} label="Add column after"><Columns3 size={15} /></TB>
            {/* FR-6.3 — merged cells. */}
            <TB onClick={() => editor?.chain().focus().mergeCells().run()}
              disabled={!inTable || !editor?.can().mergeCells()} label="Merge selected cells"><Combine size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().splitCell().run()}
              disabled={!inTable || !editor?.can().splitCell()} label="Split cell"><Split size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().toggleHeaderRow().run()}
              disabled={!inTable} label="Toggle header row"><Heading1 size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().deleteTable().run()}
              disabled={!inTable} label="Delete table"><Trash2 size={15} /></TB>
            <Divider />

            <TB onClick={() => fileInput.current?.click()} disabled={uploading}
              label={uploading ? 'Uploading image…' : 'Insert image'}>
              {uploading
                ? <Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite' }} />
                : <ImagePlus size={15} />}
            </TB>
            <TB onClick={() => editor?.chain().focus().setHorizontalRule().run()} label="Horizontal rule"><Minus size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().toggleBlockquote().run()} active={editor?.isActive('blockquote')} label="Quote"><Quote size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().toggleCodeBlock().run()} active={editor?.isActive('codeBlock')} label="Code block"><Code size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} active={editor?.isActive('heading', { level: 2 })} label="Heading 2"><Heading2 size={15} /></TB>
            <TB onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} active={editor?.isActive('heading', { level: 3 })} label="Heading 3"><Heading3 size={15} /></TB>

            {onInsertBlank && (
              <>
                <Divider />
                <button type="button" onClick={onInsertBlank} className="btn btn-secondary btn-sm"
                  title="Insert blank (Ctrl+Shift+B)" style={{ marginLeft: 2 }}>
                  <SquareDashedBottom size={14} /> Insert blank
                </button>
              </>
            )}
          </>
        )}

        {tab === 'Layout' && hasLayout && (
          <>
            <label className="sr-only" htmlFor="ribbon-page-size">Page size</label>
            <span style={{ fontSize: '0.78rem', color: 'var(--muted-foreground)' }}>Page</span>
            <select id="ribbon-page-size" style={{ ...selectStyle, width: 94 }} value={pageSize ?? 'A4'}
              onChange={(e) => onPageSettingsChange?.({
                size: e.target.value as PageSize,
                orientation: pageOrientation ?? 'portrait',
              })}>
              <option value="A4">A4</option>
              <option value="Letter">Letter</option>
            </select>

            <label className="sr-only" htmlFor="ribbon-orientation">Orientation</label>
            <select id="ribbon-orientation" style={{ ...selectStyle, width: 112 }}
              value={pageOrientation ?? 'portrait'}
              onChange={(e) => onPageSettingsChange?.({
                size: pageSize ?? 'A4',
                orientation: e.target.value as PageOrientation,
              })}>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>

            {onFurnitureChange && (
              <>
                <Divider />
                <button
                  type="button"
                  className="ribbon-btn"
                  aria-expanded={furnitureOpen}
                  aria-controls="ribbon-furniture"
                  onClick={() => setFurnitureOpen((o) => !o)}
                  title="Header and footer printed on every page of the PDF"
                  style={{ gap: 6, width: 'auto', padding: '0 8px' }}
                >
                  <PanelTop size={13} /> Header &amp; footer
                  <ChevronDown size={12} style={{
                    transform: furnitureOpen ? 'rotate(180deg)' : 'none',
                    transition: 'transform 140ms',
                  }} />
                </button>
              </>
            )}

            <span style={{ fontSize: '0.76rem', color: 'var(--muted-foreground)', marginLeft: 6 }}>
              Used by the page view and by the exported PDF.
            </span>
          </>
        )}

        {tab === 'View' && hasView && (
          <>
            {onPagedChange && (
              <TB onClick={() => onPagedChange(!paged)} active={paged}
                label={paged ? 'Continuous view' : 'Page view'}><FileText size={15} /></TB>
            )}
            {onOutlineToggle && (
              <TB onClick={onOutlineToggle} active={outlineOpen}
                label={outlineOpen ? 'Hide outline' : 'Show outline'}><PanelLeft size={15} /></TB>
            )}
            {onFind && (
              <TB onClick={onFind} label="Find and replace (Ctrl+F)"><Search size={15} /></TB>
            )}
            <span style={{ fontSize: '0.76rem', color: 'var(--muted-foreground)', marginLeft: 6 }}>
              {paged
                ? 'Page guides are approximate — the exported PDF decides the final breaks.'
                : 'Continuous view. Switch to page view to see where pages break.'}
            </span>
          </>
        )}

        <input
          ref={fileInput}
          type="file"
          accept={IMAGE_TYPES.join(',')}
          className="sr-only"
          onChange={(e) => {
            void onPickImage(e.target.files?.[0]);
            e.target.value = '';        // same file twice must still fire
          }}
        />
        {imageError && (
          <span role="alert" style={{
            fontSize: 12, color: 'var(--status-rejected-fg)', marginLeft: 4,
          }}>{imageError}</span>
        )}
      </div>

      {/* Nothing is applied until the author presses "Use this". */}
      {/* FR-6.6 — printed on every page of the exported PDF. Left blank, each
          field inherits what DocFlow derives: the document title, its
          reference number and its submission date. */}
      {tab === 'Layout' && hasLayout && onFurnitureChange && furnitureOpen && (
        <div
          id="ribbon-furniture"
          style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: 10, padding: '10px 12px', borderTop: '1px solid var(--border)',
            background: 'var(--muted)',
          }}
        >
          {([
            ['header_left', 'Header, left'],
            ['header_right', 'Header, right'],
            ['footer_left', 'Footer, left'],
            ['footer_right', 'Footer, right'],
          ] as const).map(([field, label]) => (
            <label key={field} style={{ display: 'grid', gap: 4, fontSize: '0.74rem', color: 'var(--muted-foreground)' }}>
              {label}
              <input
                className="input"
                value={(furniture ?? EMPTY_FURNITURE)[field]}
                maxLength={field.startsWith('header') ? 120 : 140}
                placeholder={FURNITURE_PLACEHOLDERS[field]}
                onChange={(e) => onFurnitureChange({
                  ...(furniture ?? EMPTY_FURNITURE),
                  [field]: e.target.value,
                })}
                style={{ fontSize: '0.8rem', padding: '5px 8px' }}
              />
            </label>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.78rem', color: 'var(--foreground)', alignSelf: 'end', paddingBottom: 5 }}>
            <input
              type="checkbox"
              checked={(furniture ?? EMPTY_FURNITURE).page_numbers}
              onChange={(e) => onFurnitureChange({
                ...(furniture ?? EMPTY_FURNITURE),
                page_numbers: e.target.checked,
              })}
              style={{ accentColor: 'var(--primary)', width: 15, height: 15 }}
            />
            Page numbers
          </label>
          <p style={{ gridColumn: '1 / -1', margin: 0, fontSize: '0.74rem', color: 'var(--muted-foreground)' }}>
            Use <code>{'{page}'}</code> and <code>{'{pages}'}</code> in a footer for
            &ldquo;Page 2 of 7&rdquo;. Leave a field empty to inherit the document&rsquo;s
            own title, reference and submission date.
          </p>
        </div>
      )}

      {/* FR-10.1 — the five named actions, over the selection itself. */}
      <AISelectionMenu
        editor={editor}
        enabled={!!ai.enabled}
        busy={rewrite.isPending}
        onPreset={(instruction) => askRewrite(instruction)}
        onCustom={() => askRewrite()}
      />

      <AIRewriteDialog
        open={rewriteOpen}
        loading={streamLoading || rewrite.isPending}
        error={(!streamLoading && !rewrite.isPending && streamError && rewrite.isError)
          ? (rewrite.error instanceof Error ? rewrite.error.message : 'AI assistance is unavailable right now.')
          : null}
        suggestion={activeSuggestion}
        onAccept={acceptRewrite}
        onReject={rejectRewrite}
        onRetry={retryRewrite}
      />
    </div>

  );
}

export default EditorToolbar;
