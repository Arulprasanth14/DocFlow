/**
 * DocFlow Frontend — Page: New Document hub + create flow (/documents/new)
 *
 * Step 1 is the hub (spec §8.2 FR-2.x, §8.4 FR-4.x, §18 points 2 & 4):
 *   - Three action cards: Start from a template · Upload a document · Blank document.
 *   - A template gallery with tabs (All / Organisation / My templates / Recent /
 *     Favourites), search, category chips and sort (Most used / Newest / A–Z),
 *     plus a hover/focus quick-look that prefetches so "Use template" is instant.
 *
 * The gallery lists TWO kinds of thing, because both really exist in this
 * product and a user does not care which is which:
 *   - Template Studio templates (fillable, versioned, FR-5.x) → Form Fill
 *   - the organisation's DocumentTypes (schema-driven forms)  → the step-2 form
 * They are normalised into one GalleryItem so the card, tabs and sort have a
 * single shape to work with.
 *
 * Step 2 is the existing structured create form for a DocumentType.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import {
  FileText, Upload, FilePlus2, Search, Star, ArrowRight, Clock, Layers, Plus, Users,
} from 'lucide-react';
import {
  useDocumentTypes,
  useCreateDocument,
  useAddDocumentAttachment,
  documentKeys,
} from '@/hooks/useDocuments';
import { useTemplates, useToggleTemplateFavourite, templateKeys } from '@/hooks/useTemplates';
import templatesApi from '@/lib/api/templates';
import { UploadDocumentModal, type UploadedSummary } from '@/components/documents/UploadDocumentModal';
import { TemplateThumbnail } from '@/components/templates/TemplateThumbnail';
import { prefersReducedMotion } from '@/lib/motion/prefersReducedMotion';
import documentsApi from '@/lib/api/documents';
import { useDepartments } from '@/hooks/useOrg';
import { useAuthStore } from '@/store/authStore';
import type { DocumentType } from '@/types';
import DynamicFormRenderer, { validateFormSchema } from '@/components/documents/DynamicFormRenderer';
import { PageHeader } from '@/components/ui/PageHeader';
import { EditorSkeleton } from '@/components/ui/EditorSkeleton';
import { useStartBlankDocument } from '@/hooks/useStartDraft';
import { preloadDocumentEditor, preloadOn, preloadTemplateEditor } from '@/lib/preload';
import { EmptyState } from '@/components/ui/EmptyState';

/** DocumentTypes have no server-side favourite table, so theirs stay local. */
const FAV_KEY = 'docflow.template.favourites';
type GalleryTab = 'all' | 'organisation' | 'mine' | 'recent' | 'favourites';
type GallerySort = 'recent' | 'most_used' | 'az';

const TABS: { key: GalleryTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'organisation', label: 'Organisation' },
  { key: 'mine', label: 'My templates' },
  { key: 'recent', label: 'Recent' },
  { key: 'favourites', label: 'Favourites' },
];

/** Rough fill-time estimate from field count (labelled as an estimate, not real data). */
const estFillMin = (fields: number) => Math.max(1, Math.round(fields * 0.5));

interface GalleryItem {
  kind: 'template' | 'doctype';
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  fieldCount: number;
  /** Real usage count for templates; null for DocumentTypes (not tracked). */
  usageCount: number | null;
  ownership: 'mine' | 'organisation';
  isFavourite: boolean;
  updatedAt: string;
  /** Present for DocumentTypes — the step-2 form needs the whole record. */
  docType?: DocumentType;
}

export default function DocumentCreatePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  // /documents/new/upload is a deep link to the hub with the upload modal open.
  const uploadOpen = location.pathname.endsWith('/upload');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const [step, setStep] = useState<1 | 2>(1);
  const [selectedType, setSelectedType] = useState<DocumentType | null>(null);

  // Common properties
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('normal');
  const [tags, setTags] = useState('');
  const [deptId, setDeptId] = useState('');
  const [dueAt, setDueAt] = useState('');

  // Dynamic form state
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState('');

  // Gallery state
  const [gallerySearch, setGallerySearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('');
  const [galleryTab, setGalleryTab] = useState<GalleryTab>('all');
  const [gallerySort, setGallerySort] = useState<GallerySort>('recent');
  const [startError, setStartError] = useState('');
  const [startingId, setStartingId] = useState<string | null>(null);
  const [localFavourites, setLocalFavourites] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); }
    catch { return new Set(); }
  });

  const { data: docTypes = [], isLoading: typesLoading } = useDocumentTypes(true);
  const { data: templates = [], isLoading: templatesLoading } = useTemplates({
    published_only: true, sort: gallerySort,
  });
  const { data: departments = [] } = useDepartments(true);
  const createDoc = useCreateDocument();
  const addAttachment = useAddDocumentAttachment();
  const toggleFavourite = useToggleTemplateFavourite();
  const canManageDocTypes = useAuthStore((s) => s.hasPermission('admin:doc_types'));

  const loading = typesLoading || templatesLoading;

  // C: "Blank document" opens the editor frame immediately and creates the
  // draft behind it, rather than routing to a page whose only content is the
  // word "Preparing". /documents/new/blank still works for old links.
  const blank = useStartBlankDocument();

  // A type with no custom fields satisfies the required FK without imposing a
  // schema-driven form on an uploaded file or a Template-Studio document.
  const blankType = docTypes.find((dt) => !dt.form_schema || dt.form_schema.length === 0) || null;

  /**
   * Upload → Continue: create the UPLOAD-source draft with the file attached,
   * then join the submission wizard at the workflow step (spec §7.4 Flow C).
   */
  const handleUploadContinue = async ({ fileAssetId, file }: UploadedSummary) => {
    if (!blankType) {
      setUploadError('No general-purpose document type exists yet. Ask an admin to add one.');
      return;
    }
    setUploadError('');
    setUploadBusy(true);
    try {
      const newDoc = await createDoc.mutateAsync({
        doc_type_id: blankType.id,
        title: file.name.replace(/\.[^.]+$/, '') || file.name,
        priority: 'normal', tags: [], form_data: {}, metadata: {},
        submit_immediately: false, source: 'upload', current_step: 'workflow',
      });
      await addAttachment.mutateAsync({ docId: newDoc.id, data: { file_asset_id: fileAssetId } });
      navigate(`/documents/${newDoc.id}/submit`);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not create the document.');
      setUploadBusy(false);
    }
  };

  const galleryRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const createOwnRef = useRef<HTMLButtonElement>(null);
  const spotlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [spotlight, setSpotlight] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  // ── normalise both sources into one list ──────────────────────────────────
  const items = useMemo<GalleryItem[]>(() => {
    const fromTemplates: GalleryItem[] = templates.map((t) => ({
      kind: 'template',
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      fieldCount: t.field_count,
      usageCount: t.usage_count,
      ownership: t.scope === 'system' ? 'organisation' : 'mine',
      isFavourite: t.is_favourite,
      updatedAt: t.updated_at,
    }));
    const fromTypes: GalleryItem[] = docTypes.map((dt) => ({
      kind: 'doctype',
      id: dt.id,
      name: dt.name,
      description: dt.description ?? null,
      category: dt.category ?? null,
      fieldCount: dt.form_schema?.length || 0,
      usageCount: null,
      ownership: 'organisation',
      isFavourite: localFavourites.has(dt.id),
      updatedAt: dt.updated_at || dt.created_at,
      docType: dt,
    }));
    return [...fromTemplates, ...fromTypes];
  }, [templates, docTypes, localFavourites]);

  const categories = useMemo(
    () => Array.from(new Set(items.map((i) => i.category).filter(Boolean))) as string[],
    [items],
  );

  const visibleItems = useMemo(() => {
    let list = items.slice();
    if (galleryTab === 'favourites') list = list.filter((i) => i.isFavourite);
    if (galleryTab === 'mine') list = list.filter((i) => i.kind === 'template' && i.ownership === 'mine');
    if (galleryTab === 'organisation') list = list.filter((i) => i.ownership === 'organisation');
    if (activeCategory) list = list.filter((i) => i.category === activeCategory);
    if (gallerySearch.trim()) {
      const q = gallerySearch.toLowerCase();
      list = list.filter((i) =>
        i.name.toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q) ||
        (i.category || '').toLowerCase().includes(q));
    }
    if (galleryTab === 'recent' || gallerySort === 'recent') {
      list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    } else if (gallerySort === 'az') {
      list.sort((a, b) => a.name.localeCompare(b.name));
    } else if (gallerySort === 'most_used') {
      // DocumentTypes have no usage count, so they sort after the templates
      // rather than pretending to be unused.
      list.sort((a, b) => (b.usageCount ?? -1) - (a.usageCount ?? -1));
    }
    return list;
  }, [items, galleryTab, activeCategory, gallerySearch, gallerySort]);

  /**
   * FR-2.4 — My Templates leads with a dashed "+" card. It stands in for the
   * empty state on that tab (an empty My Templates with a "+" card says the
   * same thing and gives you the action), but not while a search or a category
   * is narrowing the list: "nothing matched" is a different message from
   * "you have none", and the EmptyState says it better.
   */
  const showNewTemplateCard =
    galleryTab === 'mine' && !gallerySearch.trim() && !activeCategory;

  const handleToggleFavourite = (item: GalleryItem) => {
    if (item.kind === 'template') {
      toggleFavourite.mutate({ id: item.id, on: !item.isFavourite });
      return;
    }
    // DocumentTypes have no server-side favourite; keep the existing
    // per-device behaviour rather than dropping the control.
    setLocalFavourites((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
      try { localStorage.setItem(FAV_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  const prefetchItem = (item: GalleryItem) => {
    if (item.kind === 'doctype') {
      queryClient.prefetchQuery({
        queryKey: documentKeys.type(item.id),
        queryFn: () => documentsApi.getDocumentType(item.id),
        staleTime: 1000 * 60 * 5,
      });
    } else {
      queryClient.prefetchQuery({
        queryKey: templateKeys.detail(item.id),
        queryFn: () => templatesApi.get(item.id),
        staleTime: 1000 * 60 * 5,
      });
    }
  };

  /** "Use template" — the two kinds go to different places (FR-12.1 vs step 2). */
  const handleUse = async (item: GalleryItem) => {
    setStartError('');
    if (item.kind === 'doctype') {
      setSelectedType(item.docType!);
      setFormData({});
      setFormErrors({});
      setStep(2);
      return;
    }
    if (!blankType) {
      setStartError('No general-purpose document type exists yet. Ask an admin to add one before using templates.');
      return;
    }
    setStartingId(item.id);
    try {
      const newDoc = await createDoc.mutateAsync({
        doc_type_id: blankType.id,
        title: item.name,
        priority: 'normal', tags: [], form_data: {}, metadata: {},
        submit_immediately: false, source: 'template',
        template_id: item.id,          // the server pins the published version (C9)
      });
      navigate(`/documents/${newDoc.id}/fill`);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Could not start a document from this template.');
      setStartingId(null);
    }
  };

  const handleFieldChange = (key: string, value: unknown) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    if (formErrors[key]) {
      setFormErrors((prev) => { const next = { ...prev }; delete next[key]; return next; });
    }
  };

  const handleSubmit = async (submitImmediately: boolean) => {
    setGeneralError('');
    if (!title.trim()) { setGeneralError('Document Title is required.'); return; }
    if (!selectedType) return;

    const validation = validateFormSchema(selectedType.form_schema || [], formData);
    if (!validation.isValid) {
      setFormErrors(validation.errors);
      setGeneralError('Please fix the highlighted errors in the custom fields.');
      return;
    }

    try {
      const newDoc = await createDoc.mutateAsync({
        doc_type_id: selectedType.id,
        title: title.trim(),
        priority,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        dept_id: deptId || null,
        due_at: dueAt ? new Date(dueAt).toISOString() : null,
        form_data: formData, metadata: {},
        submit_immediately: false,
        // Chosen from the gallery — a 0-field type is still a template pick,
        // not a blank document (blank has its own route).
        source: 'template',
      });
      navigate(submitImmediately ? `/documents/${newDoc.id}/submit` : `/documents/${newDoc.id}`);
    } catch (err: unknown) {
      setGeneralError(err instanceof Error ? err.message : 'Failed to create document.');
    }
  };

  /**
   * "Start from a template" (FR-2.2 / §18 Point 2: "scrolls to the gallery").
   * Scrolling alone is invisible when the gallery is already on screen, so the
   * card also resets the gallery to its widest view, spotlights it and moves
   * focus into it — one perceivable result for mouse, keyboard and touch.
   */
  const startFromTemplate = () => {
    const reduced = prefersReducedMotion();
    setGalleryTab('all');
    setActiveCategory('');
    galleryRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });

    // Re-trigger the ring even when the card is clicked repeatedly.
    if (spotlightTimer.current) clearTimeout(spotlightTimer.current);
    setSpotlight(false);
    requestAnimationFrame(() => setSpotlight(true));
    spotlightTimer.current = setTimeout(() => setSpotlight(false), 1400);

    // Loading/empty galleries have no cards to land on; the toolbar is always
    // rendered, so focus the search — or "Create your own template" when there
    // is nothing to search at all.
    const wantsCreate = !loading && items.length === 0;
    if (focusTimer.current) clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => {
      const el = wantsCreate ? createOwnRef.current : searchRef.current;
      el?.focus({ preventScroll: true });
      if (!wantsCreate) searchRef.current?.select();
    }, reduced ? 0 : 320);

    setAnnouncement(
      loading ? 'Template gallery. Loading templates…'
        : wantsCreate ? 'Template gallery. No templates yet — create your own template.'
          : `Template gallery, ${items.length} template${items.length === 1 ? '' : 's'}. Search focused.`,
    );
  };

  useEffect(() => () => {
    if (spotlightTimer.current) clearTimeout(spotlightTimer.current);
    if (focusTimer.current) clearTimeout(focusTimer.current);
  }, []);

  // The editor frame takes over the whole page the moment the card is
  // pressed, so the transition the author sees is hub -> editor, with no
  // waiting screen in between (under 200ms of movement, per C).
  if (blank.starting) return <EditorSkeleton label="Opening your blank document" />;

  return (
    <div className="page-content" style={{ paddingTop: 24, maxWidth: step === 1 ? 1200 : 1040, margin: '0 auto' }}>
      <div style={{ marginBottom: 16 }}>
        <button
          onClick={() => (step === 2 ? setStep(1) : navigate('/documents'))}
          className="btn btn-ghost btn-sm"
          style={{ marginBottom: 12, paddingLeft: 0 }}
        >
          ← {step === 2 ? 'Back to hub' : 'Back to documents'}
        </button>
        <PageHeader
          breadcrumbs={[{ label: 'Documents' }, { label: step === 1 ? 'New' : 'Create' }]}
          title={step === 1 ? 'New document' : `Create ${selectedType?.name || 'Document'}`}
          description={step === 1
            ? 'Start from a template, upload a file, or begin with a blank document.'
            : 'Fill in the document properties and required fields below.'}
        />
      </div>

      {/* ── STEP 1: Hub ── */}
      {step === 1 && (
        <div>
          {/* The blank draft is created in the background, so a failure has
              to be said here — the card simply comes back. */}
          {blank.error && (
            <div role="alert" style={{
              padding: '12px 16px', marginBottom: 16, borderRadius: 'var(--radius)',
              background: 'var(--status-rejected-bg)', color: 'var(--status-rejected)',
              fontSize: '0.85rem', fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            }}>
              <span>{blank.error}</span>
              <button className="btn btn-secondary btn-sm" onClick={blank.start}>Try again</button>
            </div>
          )}

          {/* Action cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginBottom: 32 }}>
            <ActionCard
              icon={<Layers size={20} />} tone="primary"
              title="Start from a template"
              desc="Use a pre-built form for a faster, consistent document."
              onClick={startFromTemplate}
            />
            <ActionCard
              icon={<Upload size={20} />} tone="cyan"
              title="Upload a document"
              desc="Bring a DOCX or PDF you already have and submit it as-is."
              onClick={() => navigate('/documents/new/upload')}
              disabled={!blankType}
              disabledHint="Ask an admin to add a general-purpose document type first."
            />
            <ActionCard
              icon={<FilePlus2 size={20} />} tone="violet"
              title="Blank document"
              desc="Begin from an empty document and fill in the details."
              onClick={blank.start}
              hoverProps={preloadOn(preloadDocumentEditor)}
              disabled={!!blank.blocked}
              disabledHint={blank.blocked}
            />
          </div>

          {/* Template gallery */}
          <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
          <div ref={galleryRef} className={spotlight ? 'gallery-spotlight' : undefined}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <h2 className="font-heading" style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--foreground)', margin: 0 }}>
                Template gallery
              </h2>
              <div role="tablist" aria-label="Template filters" style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 8 }}>
                {TABS.map((t) => (
                  <button key={t.key} role="tab" aria-selected={galleryTab === t.key}
                    onClick={() => setGalleryTab(t.key)} style={{
                      padding: '6px 12px', fontSize: '0.82rem', fontWeight: galleryTab === t.key ? 700 : 500,
                      borderRadius: 'var(--radius-pill)', border: 'none', cursor: 'pointer',
                      background: galleryTab === t.key ? 'var(--secondary)' : 'transparent',
                      color: galleryTab === t.key ? 'var(--secondary-foreground)' : 'var(--muted-foreground)',
                      fontFamily: 'var(--font-sans)', whiteSpace: 'nowrap',
                    }}>{t.label}</button>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
                <div style={{ position: 'relative', width: 200 }}>
                  <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-foreground)', pointerEvents: 'none' }} />
                  <input ref={searchRef} className="input" value={gallerySearch} onChange={(e) => setGallerySearch(e.target.value)}
                    placeholder="Search templates…" aria-label="Search templates" style={{ paddingLeft: 34, height: 38 }} />
                </div>
                <select value={gallerySort} onChange={(e) => setGallerySort(e.target.value as GallerySort)}
                  aria-label="Sort templates"
                  style={{
                    fontSize: '0.82rem', padding: '8px 12px', background: 'var(--card)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)', color: 'var(--foreground)', cursor: 'pointer', fontFamily: 'var(--font-sans)',
                  }}>
                  <option value="most_used">Most used</option>
                  <option value="recent">Newest</option>
                  <option value="az">A–Z</option>
                </select>
                {/* FR-2.4 — Template Studio entry points */}
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/documents/templates/mine')}>
                  My templates
                </button>
                <button ref={createOwnRef} className="btn btn-primary btn-sm" onClick={() => navigate('/documents/templates/new')}>
                  <Plus size={14} /> Create your own template
                </button>
              </div>
            </div>

            {/* Category chips */}
            {categories.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                <Chip active={activeCategory === ''} onClick={() => setActiveCategory('')}>All categories</Chip>
                {categories.map((c) => (
                  <Chip key={c} active={activeCategory === c} onClick={() => setActiveCategory(c)}>{c}</Chip>
                ))}
              </div>
            )}

            {startError && (
              <div role="alert" style={{
                padding: '12px 16px', marginBottom: 16, borderRadius: 'var(--radius)',
                background: 'var(--status-rejected-bg)', color: 'var(--status-rejected)',
                fontSize: '0.85rem', fontWeight: 600,
              }}>{startError}</div>
            )}

            {loading ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 20 }}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="skeleton" style={{ height: 200, borderRadius: 'var(--radius-lg)' }} />
                ))}
              </div>
            ) : items.length === 0 ? (
              <EmptyState art="documents" title="No templates yet"
                description={canManageDocTypes
                  ? "You're an admin — create a document type, or build your own template."
                  : 'Create your own template, or ask an administrator to add document types.'}
                action={
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button className="btn btn-primary" onClick={() => navigate('/documents/templates/new')}>
                      <Plus size={15} /> Create a template
                    </button>
                    {canManageDocTypes && (
                      <button className="btn btn-secondary" onClick={() => navigate('/admin/document-types')}>
                        Document types
                      </button>
                    )}
                  </div>
                } />
            ) : visibleItems.length === 0 && !showNewTemplateCard ? (
              <EmptyState art="search"
                title={galleryTab === 'mine' ? 'You have no templates yet'
                  : galleryTab === 'favourites' ? 'No favourites yet'
                    : 'No templates match'}
                description={galleryTab === 'mine' ? 'Turn a document you use often into a template.'
                  : galleryTab === 'favourites' ? 'Star a template to find it here quickly.'
                    : 'Try a different search, category, or tab.'}
                action={galleryTab === 'mine'
                  ? <button className="btn btn-primary" onClick={() => navigate('/documents/templates/new')}><Plus size={15} /> Create your first</button>
                  : <button className="btn btn-secondary" onClick={() => { setGallerySearch(''); setActiveCategory(''); setGalleryTab('all'); }}>Clear</button>} />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 20 }}>
                {/* FR-2.4 — the dashed "+" card leads My Templates, so the way to
                    make one is in the grid itself and not only in the toolbar. */}
                {showNewTemplateCard && <NewTemplateCard onClick={() => navigate('/documents/templates/new')} />}
                {visibleItems.map((item) => (
                  <TemplateCard
                    key={`${item.kind}-${item.id}`} item={item}
                    busy={startingId === item.id}
                    onToggleFavourite={() => handleToggleFavourite(item)}
                    onUse={() => void handleUse(item)}
                    onPrefetch={() => prefetchItem(item)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Upload modal — opened by the card and by the /documents/new/upload deep link */}
      <UploadDocumentModal
        open={uploadOpen}
        busy={uploadBusy}
        error={uploadError}
        onClose={() => { setUploadError(''); navigate('/documents/new'); }}
        onContinue={handleUploadContinue}
      />

      {/* ── STEP 2: Fill general + custom fields ── */}
      {step === 2 && selectedType && (
        <div className="glass-card" style={{ padding: 32 }}>
          {generalError && (
            <div role="alert" style={{
              padding: '14px 18px', background: 'var(--status-rejected-bg)',
              border: '1px solid color-mix(in srgb, var(--status-rejected) 30%, transparent)',
              borderRadius: 'var(--radius)', color: 'var(--status-rejected)', fontSize: '0.88rem', fontWeight: 600, marginBottom: 24,
            }}>{generalError}</div>
          )}

          <div style={{ marginBottom: 32 }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--foreground)', marginBottom: 16, paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
              General information
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={labelStyle} htmlFor="dc-title">Document title <span style={{ color: 'var(--status-rejected)' }}>*</span></label>
                <input id="dc-title" type="text" className="input" placeholder="e.g. Q3 Marketing Budget Plan"
                  value={title} onChange={(e) => setTitle(e.target.value)} required />
              </div>
              <div>
                <label style={labelStyle} htmlFor="dc-priority">Priority</label>
                <select id="dc-priority" className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                  <option value="low">Low</option>
                </select>
              </div>
              <div>
                <label style={labelStyle} htmlFor="dc-due">Target due date (optional)</label>
                <input id="dc-due" type="date" className="input" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={labelStyle} htmlFor="dc-tags">Tags (comma-separated)</label>
                <input id="dc-tags" type="text" className="input" placeholder="e.g. urgent, legal, q3" value={tags} onChange={(e) => setTags(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle} htmlFor="dc-dept">Department (optional)</label>
                <select id="dc-dept" className="input" value={deptId} onChange={(e) => setDeptId(e.target.value)}>
                  <option value="">— Unassigned —</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            </div>
          </div>

          {selectedType.form_schema && selectedType.form_schema.length > 0 && (
            <div style={{ marginBottom: 36 }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--foreground)', marginBottom: 16, paddingBottom: 10, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Custom fields</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--muted-foreground)' }}>
                  {selectedType.form_schema.length} field(s)
                </span>
              </h3>
              <DynamicFormRenderer schema={selectedType.form_schema || []} values={formData} onChange={handleFieldChange} errors={formErrors} />
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
            <button type="button" className="btn btn-secondary" disabled={createDoc.isPending} onClick={() => handleSubmit(false)}>
              Save as draft
            </button>
            <button type="button" className="btn btn-primary" disabled={createDoc.isPending} onClick={() => handleSubmit(true)}>
              {createDoc.isPending ? 'Creating…' : 'Continue to submit →'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--foreground)', marginBottom: 6,
};

// ── Action card ─────────────────────────────────────────────────────────────────
function ActionCard({ icon, title, desc, onClick, tone, disabled, busy, disabledHint, hoverProps }: {
  icon: React.ReactNode; title: string; desc: string; onClick: () => void;
  tone: 'primary' | 'cyan' | 'violet'; disabled?: boolean; busy?: boolean; disabledHint?: string;
  /** From preloadOn(): starts the destination's chunk downloading early. */
  hoverProps?: { onMouseEnter: () => void; onFocus: () => void; onTouchStart: () => void };
}) {
  const toneColor = tone === 'primary' ? 'var(--primary)' : tone === 'cyan' ? 'var(--chart-2)' : 'var(--accent-violet)';
  return (
    <motion.button
      whileHover={disabled ? undefined : { y: -2 }}
      onClick={disabled ? undefined : onClick}
      {...(disabled ? {} : hoverProps)}
      disabled={disabled}
      title={disabled ? disabledHint : undefined}
      className="glass-interactive"
      style={{
        textAlign: 'left', padding: 20, borderRadius: 'var(--radius-lg)', cursor: disabled ? 'not-allowed' : 'pointer',
        border: '1px solid var(--border)', background: 'var(--card)', opacity: disabled ? 0.55 : 1,
        display: 'flex', flexDirection: 'column', gap: 10, minHeight: 132, fontFamily: 'var(--font-sans)',
      }}
    >
      <span style={{
        width: 44, height: 44, borderRadius: 'var(--radius)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `color-mix(in srgb, ${toneColor} 12%, transparent)`, color: toneColor,
      }}>{icon}</span>
      <span style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--foreground)' }}>{busy ? 'Uploading…' : title}</span>
      <span style={{ fontSize: '0.84rem', color: 'var(--muted-foreground)', lineHeight: 1.45 }}>{desc}</span>
    </motion.button>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '5px 12px', fontSize: '0.8rem', fontWeight: 600, borderRadius: 'var(--radius-pill)', cursor: 'pointer',
      border: '1px solid', fontFamily: 'var(--font-sans)',
      borderColor: active ? 'transparent' : 'var(--border)',
      background: active ? 'var(--primary)' : 'transparent',
      color: active ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
    }}>{children}</button>
  );
}

// ── The dashed "+" card that leads My Templates (FR-2.4) ────────────────────────
function NewTemplateCard({ onClick }: { onClick: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      {...preloadOn(preloadTemplateEditor)}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.16 }}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 10, minHeight: 200, padding: 20, cursor: 'pointer', textAlign: 'center',
        border: '2px dashed var(--border)', borderRadius: 'var(--radius-lg)',
        background: 'var(--card)', color: 'var(--muted-foreground)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <span style={{
        width: 44, height: 44, borderRadius: '50%', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'color-mix(in srgb, var(--primary) 10%, transparent)',
        color: 'var(--primary)',
      }}>
        <Plus size={22} />
      </span>
      <span style={{ fontSize: '0.92rem', fontWeight: 700, color: 'var(--foreground)' }}>
        Create a template
      </span>
      <span style={{ fontSize: '0.8rem' }}>
        Start from scratch, or import a Word document
      </span>
    </motion.button>
  );
}

// ── Template card with hover/focus quick-look ────────────────────────────────────
function TemplateCard({ item, busy, onToggleFavourite, onUse, onPrefetch }: {
  item: GalleryItem; busy: boolean; onToggleFavourite: () => void; onUse: () => void; onPrefetch: () => void;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { fieldCount } = item;

  const show = () => { // 200 ms hover-intent delay (FR-4.1)
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setOpen(true); onPrefetch(); }, 200);
  };
  const hide = () => { if (timer.current) clearTimeout(timer.current); setOpen(false); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <div
      onMouseEnter={show} onMouseLeave={hide}
      onFocus={() => { setOpen(true); onPrefetch(); }} onBlur={hide}
      // The whole card is the primary target — the quick-look button is a
      // convenience, not the only way in (it is unreachable without hover).
      // The hit area is the title button's stretched ::after rather than a
      // role="button" wrapper, which may not contain the star / quick-look
      // buttons it needs to hold.
      style={{
        position: 'relative', overflow: 'hidden', minHeight: 200, display: 'flex', flexDirection: 'column',
        padding: 20, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', background: 'var(--card)',
        cursor: 'pointer', opacity: busy ? 0.7 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <span style={{
            fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
            color: 'var(--primary)', background: 'color-mix(in srgb, var(--primary) 10%, transparent)',
            padding: '3px 8px', borderRadius: 'var(--radius-sm)',
          }}>{item.category || 'General'}</span>
          {/* Ownership badge — FR-2.5 */}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: '0.7rem', fontWeight: 700, padding: '3px 8px', borderRadius: 'var(--radius-sm)',
            color: 'var(--muted-foreground)', background: 'var(--muted)',
          }}>
            {item.ownership === 'mine' ? <Star size={10} /> : <Users size={10} />}
            {item.ownership === 'mine' ? 'Mine' : 'Organisation'}
          </span>
        </div>
        <button
          onClick={onToggleFavourite}
          aria-label={`${item.isFavourite ? 'Unfavourite' : 'Favourite'} ${item.name}`}
          title={item.kind === 'template' ? 'Favourite' : 'Favourite (saved on this device)'}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer', padding: 2,
            color: item.isFavourite ? 'var(--accent-amber)' : 'var(--muted-foreground)',
            position: 'relative', zIndex: 2,
          }}>
          <Star size={16} fill={item.isFavourite ? 'var(--accent-amber)' : 'none'} />
        </button>
      </div>

      <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--foreground)', marginBottom: 8 }}>
        <button className="card-stretch" onClick={onUse} disabled={busy} style={{
          background: 'none', border: 'none', padding: 0, textAlign: 'left',
          cursor: busy ? 'progress' : 'pointer',
          fontFamily: 'var(--font-sans)', fontSize: 'inherit', fontWeight: 'inherit', color: 'inherit',
        }}>{item.name}</button>
      </h3>
      <p style={{ fontSize: '0.85rem', color: 'var(--muted-foreground)', lineHeight: 1.5, flex: 1 }}>
        {item.description || 'No description provided.'}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: '0.78rem', color: 'var(--muted-foreground)', fontWeight: 600 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><FileText size={13} /> {fieldCount} field{fieldCount === 1 ? '' : 's'}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Clock size={13} /> ~{estFillMin(fieldCount)} min</span>
        {item.usageCount != null && (
          <span title="Documents created from this template">{item.usageCount} use{item.usageCount === 1 ? '' : 's'}</span>
        )}
      </div>

      {/* Quick-look overlay — slides up on hover/focus, no layout shift (FR-4.2) */}
      <motion.div
        initial={false}
        animate={{ y: open ? 0 : '101%' }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, padding: 20,
          background: 'var(--card-solid)', borderTop: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: 10, boxShadow: 'var(--shadow-lg)',
          zIndex: 2,
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          {/* First-page thumbnail (FR-4.1). Only mounted while the quick-look
              is open, so nothing is fetched or rendered until then (FR-4.3). */}
          <TemplateThumbnail
            templateId={item.kind === 'template' ? item.id : null}
            active={open}
            fieldCount={fieldCount}
          />
          <div style={{ minWidth: 0, display: 'grid', gap: 6 }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--muted-foreground)' }}>
              {fieldCount} question{fieldCount === 1 ? '' : 's'} · ~{estFillMin(fieldCount)} min
            </div>
            <p style={{ fontSize: '0.82rem', color: 'var(--muted-foreground)', lineHeight: 1.4, margin: 0, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {item.description || 'Start a document using this template.'}
            </p>
          </div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={onUse} disabled={busy}
          style={{ alignSelf: 'flex-start' }} tabIndex={open ? 0 : -1}>
          {busy ? 'Starting…' : 'Use template'} <ArrowRight size={14} />
        </button>
      </motion.div>
    </div>
  );
}
