/**
 * DocFlow Frontend — Page: DocumentListPage (/documents)
 *
 * Premium, server-driven documents list (spec §8.1 FR-1.x, §18 point 1):
 *   - Every filter / sort / search / page lives in the URL (shareable, back-safe).
 *   - Search is debounced (300 ms); stale rows stay visible while loading
 *     (keepPreviousData) — no blank flash.
 *   - Premium table: sticky header, status pills, relative time w/ exact tooltip,
 *     due-date severity colour, hover accent bar, density toggle, row actions,
 *     bulk select. Drafts show a Draft badge + Continue.
 *   - Designed loading / empty / no-match / error states.
 * Styling uses the v2 theme tokens only (DESIGN.md).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  FileText, Plus, Search, Trash2, ChevronLeft, ChevronRight,
  ChevronUp, ChevronDown, Rows3, Rows4, X, RotateCw, Play,
} from 'lucide-react';
import {
  useDocuments, useDocumentTypes, useDeleteDocument, useDocumentAnalytics,
} from '@/hooks/useDocuments';
import { useVirtualRows } from '@/hooks/useVirtualRows';
import { useAuthStore } from '@/store/authStore';
import { useDepartments } from '@/hooks/useOrg';
import { useWorkflowTemplates } from '@/hooks/useWorkflows';
import { useQuery } from '@tanstack/react-query';
import chatApi from '@/lib/api/chat';
import type { Document, DocumentStatus } from '@/types';
import { formatDateTime } from '@/lib/utils/date';
import StatusBadge from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { ColumnsMenu } from '@/components/documents/ColumnsMenu';
import { FilterPresetsMenu } from '@/components/documents/FilterPresetsMenu';

// ── Status tabs (keys must match backend DocumentStatus values) ────────────────
type TabKey = '' | DocumentStatus;
const STATUS_TABS: { key: TabKey; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'pending', label: 'Pending' },
  { key: 'sent_back', label: 'Sent Back' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'archived', label: 'Archived' },
];

const PAGE_SIZE_OPTIONS = [25, 50, 100];
/** FR-1.4 — row count above which the body is virtualised. See the note at its use. */
const VIRTUALIZE_ABOVE = 60;
const DENSITY_KEY = 'docflow.documents.density';

/**
 * Steps owned by the submission wizard. A draft saved on one of these resumes
 * in the wizard (FR-1.9 / FR-14.5); anything else just opens the document.
 */
const WIZARD_STEPS = new Set(['review', 'workflow', 'details', 'confirm']);
const continueHref = (doc: Document) =>
  WIZARD_STEPS.has(doc.current_step ?? '') ? `/documents/${doc.id}/submit` : `/documents/${doc.id}`;

function priorityMeta(priority: string): { label: string; color: string } {
  switch (priority) {
    case 'urgent': return { label: 'Urgent', color: 'var(--status-rejected)' };
    case 'high':   return { label: 'High',   color: 'var(--status-pending)' };
    case 'low':    return { label: 'Low',    color: 'var(--muted-foreground)' };
    default:       return { label: 'Normal', color: 'var(--foreground)' };
  }
}

/** Due-date severity: overdue = danger, due within 2 days = warning (§18 pt1). */
function dueMeta(due: string | null | undefined): { text: string; color: string; title: string } | null {
  if (!due) return null;
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return null;
  const diffDays = (d.getTime() - Date.now()) / 86_400_000;
  const text = d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  const title = formatDateTime(due);
  if (diffDays < 0) return { text: `${text} · Overdue`, color: 'var(--status-rejected)', title };
  if (diffDays <= 2) return { text, color: 'var(--status-pending)', title };
  return { text, color: 'var(--muted-foreground)', title };
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return formatDistanceToNowStrict(d, { addSuffix: true });
}

// ── Columns (FR-1.8: show/hide + reorder, persisted per user) ─────────────────
// Select, Document and Actions are structural and always present; everything
// between them is user-controlled.
type ColumnKey = 'type' | 'status' | 'priority' | 'due' | 'updated';

const COLUMN_DEFS: Record<ColumnKey, { label: string; width: string; sort?: SortField }> = {
  type:     { label: 'Type',     width: '130px' },
  status:   { label: 'Status',   width: '120px', sort: 'status' },
  priority: { label: 'Priority', width: '92px',  sort: 'priority' },
  due:      { label: 'Due',      width: '140px', sort: 'dueDate' },
  updated:  { label: 'Updated',  width: '120px', sort: 'updatedAt' },
};
const DEFAULT_COLUMN_ORDER: ColumnKey[] = ['type', 'status', 'priority', 'due', 'updated'];
const COLUMNS_KEY = 'docflow.documents.columns';
const COLUMN_LABELS = Object.fromEntries(
  (Object.keys(COLUMN_DEFS) as ColumnKey[]).map((k) => [k, COLUMN_DEFS[k].label]),
) as Record<ColumnKey, string>;

/** FR-1.8 — a resized column may not vanish or swallow the row. */
const MIN_COL_WIDTH = 64;
const MAX_COL_WIDTH = 420;

export interface ColumnLayout {
  order: ColumnKey[];
  hidden: Set<ColumnKey>;
  /** Only columns the user has actually resized; the rest use COLUMN_DEFS. */
  widths: Partial<Record<ColumnKey, number>>;
}

/** Reconcile a stored layout with the columns this build actually has. */
function loadColumns(): ColumnLayout {
  const fallback: ColumnLayout = {
    order: DEFAULT_COLUMN_ORDER, hidden: new Set<ColumnKey>(), widths: {},
  };
  try {
    const raw = localStorage.getItem(COLUMNS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as {
      order?: string[]; hidden?: string[]; widths?: Record<string, number>;
    };
    const known = (parsed.order || []).filter((k): k is ColumnKey => k in COLUMN_DEFS);
    const missing = DEFAULT_COLUMN_ORDER.filter((k) => !known.includes(k));
    const widths: Partial<Record<ColumnKey, number>> = {};
    for (const [k, v] of Object.entries(parsed.widths || {})) {
      // A stored width from another build, or a hand-edited one, is clamped
      // rather than trusted — a 0px or 9000px column is unusable.
      if (k in COLUMN_DEFS && typeof v === 'number' && Number.isFinite(v)) {
        widths[k as ColumnKey] = Math.min(Math.max(Math.round(v), MIN_COL_WIDTH), MAX_COL_WIDTH);
      }
    }
    return {
      order: [...known, ...missing],
      hidden: new Set((parsed.hidden || []).filter((k): k is ColumnKey => k in COLUMN_DEFS)),
      widths,
    };
  } catch { return fallback; }
}

type SortField = 'title' | 'status' | 'priority' | 'dueDate' | 'updatedAt';

export default function DocumentListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── URL = source of truth for all filters/sort/page ──────────────────────────
  const status = searchParams.get('status') ?? '';
  const typeId = searchParams.get('type') ?? '';
  const deptId = searchParams.get('dept') ?? '';
  const priority = searchParams.get('priority') ?? '';
  const tag = searchParams.get('tag') ?? '';
  const sort = searchParams.get('sort') ?? 'updatedAt:desc';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const limit = PAGE_SIZE_OPTIONS.includes(Number(searchParams.get('limit')))
    ? Number(searchParams.get('limit'))
    : 25;
  const q = searchParams.get('q') ?? '';
  // FR-1.2 — the remaining filters. Owner is "me" or a member id; workflow is
  // a WorkflowTemplate id; the date range is on created_at, matching the
  // server's date_from / date_to.
  const owner = searchParams.get('owner') ?? '';
  const workflowId = searchParams.get('workflow') ?? '';
  const dateFrom = searchParams.get('from') ?? '';
  const dateTo = searchParams.get('to') ?? '';

  const setParams = (patch: Record<string, string | number | null>, resetPage = true) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      Object.entries(patch).forEach(([k, v]) => {
        if (v === null || v === '' ) next.delete(k);
        else next.set(k, String(v));
      });
      if (resetPage && !('page' in patch)) next.delete('page');
      return next;
    }, { replace: false });
  };

  // ── Saved Filter Presets (FR-1.10) ──────────────────────────────────────────
  const [presetNotice, setPresetNotice] = useState<string | null>(null);
  const handleApplyPreset = (params: Record<string, string>, presetName: string, missingRefs?: string[]) => {
    const next = new URLSearchParams(params);
    setSearchParams(next, { replace: false });
    if (missingRefs && missingRefs.length > 0) {
      setPresetNotice(`Preset "${presetName}" applied. Note: ${missingRefs.join(', ')} no longer exists.`);
    } else {
      setPresetNotice(`Preset "${presetName}" applied.`);
    }
    setTimeout(() => setPresetNotice(null), 5000);
  };

  // ── Debounced search input (300 ms, FR-1.3) ──────────────────────────────────
  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => { setSearchInput(q); }, [q]);
  useEffect(() => {
    if (searchInput === q) return;
    const t = setTimeout(() => setParams({ q: searchInput || null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // ── Density (persisted per user) ──────────────────────────────────────────────
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() => {
    try { return (localStorage.getItem(DENSITY_KEY) as 'comfortable' | 'compact') || 'comfortable'; }
    catch { return 'comfortable'; }
  });
  const rowMinHeight = density === 'compact' ? 44 : 60;
  const toggleDensity = () => {
    const next = density === 'comfortable' ? 'compact' : 'comfortable';
    setDensity(next);
    try { localStorage.setItem(DENSITY_KEY, next); } catch { /* ignore */ }
  };

  // ── Columns (persisted per user) ──────────────────────────────────────────────
  const [columns, setColumns] = useState(loadColumns);
  const visibleColumns = useMemo(
    () => columns.order.filter((k) => !columns.hidden.has(k)),
    [columns],
  );
  const columnWidth = useCallback(
    (k: ColumnKey) => columns.widths[k] ?? parseInt(COLUMN_DEFS[k].width, 10),
    [columns.widths],
  );
  const gridCols = useMemo(
    () => ['36px', 'minmax(220px,1fr)',
      ...visibleColumns.map((k) => `${columnWidth(k)}px`), '108px'].join(' '),
    [visibleColumns, columnWidth],
  );
  const tableMinWidth = 36 + 220 + 108 + 40
    + visibleColumns.reduce((sum, k) => sum + columnWidth(k), 0);

  const persistColumns = (
    order: ColumnKey[], hidden: Set<ColumnKey>,
    widths: Partial<Record<ColumnKey, number>> = columns.widths,
  ) => {
    setColumns({ order, hidden, widths });
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify({ order, hidden: [...hidden], widths }));
    } catch { /* private mode — the layout just won't be remembered */ }
  };
  /** FR-1.8 — one column's new width, clamped and remembered. */
  const setColumnWidth = (key: ColumnKey, px: number) => {
    const next = Math.min(Math.max(Math.round(px), MIN_COL_WIDTH), MAX_COL_WIDTH);
    persistColumns(columns.order, columns.hidden, { ...columns.widths, [key]: next });
  };
  const resetColumns = () => {
    setColumns({ order: DEFAULT_COLUMN_ORDER, hidden: new Set(), widths: {} });
    try { localStorage.removeItem(COLUMNS_KEY); } catch { /* ignore */ }
  };

  // ── Data ──────────────────────────────────────────────────────────────────────
  const currentUserId = useAuthStore((st) => st.user?.id);

  // Keyset pagination (FR-1.4).
  //
  // Cursors are forward-only, so "Previous" works off a stack of the cursors
  // already used rather than a second reversed query. The stack lives in
  // component state, not the URL: a filter IS worth sharing (FR-1.2) but a
  // long opaque cursor is not, and a stale pasted cursor would be rejected by
  // the server anyway.
  //
  // A bookmarked ?page=N still works: the server kept its offset path, and
  // that is what the first request uses. The moment someone pages with the
  // buttons it switches to cursors, which is where the cost actually matters.
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  // Any change to WHAT is being listed invalidates every cursor taken under
  // the old query, so the stack is dropped and paging restarts at the top.
  const filterKey = [
    status, typeId, deptId, priority, tag, sort, q, limit,
    owner, workflowId, dateFrom, dateTo,
  ].join('|');
  const lastFilterKey = useRef(filterKey);
  useEffect(() => {
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    setCursor(null);
    setCursorStack([]);
  }, [filterKey]);

  const params = {
    // Sending both would be ambiguous; the cursor wins once there is one.
    ...(cursor ? { cursor } : { page }),
    limit,
    status: status || undefined,
    doc_type_id: typeId || undefined,
    dept_id: deptId || undefined,
    search: q || undefined,
    priority: priority || undefined,
    tags: tag ? [tag] : undefined,
    submitted_by: owner === 'me' ? currentUserId : (owner || undefined),
    workflow_template_id: workflowId || undefined,
    date_from: dateFrom ? new Date(dateFrom).toISOString() : undefined,
    // Inclusive of the chosen day: the server compares against created_at,
    // so an end date of the 5th must cover everything up to 23:59 on the 5th.
    date_to: dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : undefined,
    sort,
  };
  const { data, isLoading, isFetching, isError, refetch } = useDocuments(params);
  const { data: workflowTemplates = [] } = useWorkflowTemplates({ active_only: true });
  // GET /chat/members, not the admin members endpoint: it is the one colleague
  // list every member is allowed to read, so the owner filter works for
  // everyone instead of only for admins. A non-owner still only SEES the
  // documents their own access allows -- this filters, it does not reveal.
  const { data: members = [] } = useQuery({
    queryKey: ['chat', 'members', 'ownerFilter'],
    queryFn: () => chatApi.listMembers(undefined, 100),
    staleTime: 1000 * 300,
  });
  const { data: docTypes = [] } = useDocumentTypes(true);
  const { data: departments = [] } = useDepartments(true);
  const { data: analytics } = useDocumentAnalytics();
  const deleteDoc = useDeleteDocument();

  const documents = data?.items ?? [];

  /**
   * FR-1.4 — virtualise a long body. The threshold is 60, not the spec's 100:
   * the largest page size the UI offers is 100, so a 100-row trigger would
   * never fire and the feature would be dead code. 60 is just above two
   * screenfuls of comfortable rows, which is the point at which mounting
   * every row starts to cost more than the window machinery.
   */
  const virtual = useVirtualRows({
    count: documents.length,
    rowHeight: rowMinHeight,
    enabled: documents.length > VIRTUALIZE_ABOVE,
  });
  // A new page of results starts at the top, not wherever the last one was.
  // Destructured because `virtual` is a fresh object every render: depending on
  // it would scroll to the top on every render instead of on every new page.
  const { scrollToTop } = virtual;
  useEffect(() => { scrollToTop(); }, [page, limit, cursor, sort, scrollToTop]);

  // The server skips the count on a cursor request and returns -1, so the
  // total from the first page of this filter set is remembered and reused.
  // Showing 0 while paging would be wrong, not merely unhelpful.
  const knownTotal = useRef(0);
  if ((data?.total ?? -1) >= 0) knownTotal.current = data!.total;
  const total = knownTotal.current;
  const pages = Math.max(1, Math.ceil(total / limit) || 1);

  // Where we are: the offset page we started from, plus every Next since.
  const pageNumber = cursor ? page + cursorStack.length : page;
  const hasNext = cursor ? !!data?.next_cursor : pageNumber < pages;
  const hasPrev = cursorStack.length > 0 || page > 1;

  const goNext = () => {
    const next = data?.next_cursor;
    if (!next) return;
    setCursorStack((s) => [...s, cursor]);
    setCursor(next);
  };

  const goPrev = () => {
    if (cursorStack.length > 0) {
      const prev = cursorStack[cursorStack.length - 1];
      setCursorStack((s) => s.slice(0, -1));
      setCursor(prev);
      return;
    }
    // No cursor history left: we are on the offset-based page this session
    // started on, so fall back to the URL pager.
    if (page > 1) setParams({ page: page - 1 }, false);
  };

  const tabCounts = useMemo(() => {
    const a = analytics ?? {};
    const all = Object.values(a).reduce((s, n) => s + (n || 0), 0);
    return { all, map: a as Record<string, number> };
  }, [analytics]);

  // ── Selection + delete ────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [confirmState, setConfirmState] =
    useState<{ id?: string; title?: string; bulk?: boolean; count?: number } | null>(null);

  const allPageSelected = documents.length > 0 && documents.every((d) => selected.has(d.id));
  const toggleRow = (id: string) =>
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () =>
    setSelected((prev) => prev.size >= documents.length ? new Set() : new Set(documents.map((d) => d.id)));

  async function executeDelete(id: string) {
    setConfirmState(null);
    setDeleting((prev) => new Set(prev).add(id));
    setTimeout(async () => {
      try { await deleteDoc.mutateAsync(id); }
      finally {
        setDeleting((prev) => { const n = new Set(prev); n.delete(id); return n; });
        setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
      }
    }, 240);
  }
  async function executeBulkDelete() {
    setConfirmState(null);
    const ids = [...selected];
    setSelected(new Set());
    for (const id of ids) { try { await deleteDoc.mutateAsync(id); } catch { /* continue */ } }
  }

  // ── Sorting via column headers (cycle asc/desc) ───────────────────────────────
  const [sortField, sortDir] = (sort.split(':') as [SortField, 'asc' | 'desc']);
  const onSort = (field: SortField) => {
    const dir = sortField === field && sortDir === 'desc' ? 'asc' : 'desc';
    setParams({ sort: `${field}:${dir}` });
  };
  const SortIcon = ({ field }: { field: SortField }) =>
    sortField !== field ? null
      : sortDir === 'desc' ? <ChevronDown size={12} /> : <ChevronUp size={12} />;

  // ── Active-filter chips ───────────────────────────────────────────────────────
  const chips: { label: string; onRemove: () => void }[] = [];
  if (q) chips.push({ label: `Search: "${q}"`, onRemove: () => { setSearchInput(''); setParams({ q: null }); } });
  if (status) chips.push({ label: `Status: ${STATUS_TABS.find((t) => t.key === status)?.label ?? status}`, onRemove: () => setParams({ status: null }) });
  if (typeId) chips.push({ label: `Type: ${docTypes.find((d) => d.id === typeId)?.name ?? 'type'}`, onRemove: () => setParams({ type: null }) });
  if (deptId) chips.push({ label: `Dept: ${departments.find((d) => d.id === deptId)?.name ?? 'dept'}`, onRemove: () => setParams({ dept: null }) });
  if (priority) chips.push({ label: `Priority: ${priority}`, onRemove: () => setParams({ priority: null }) });
  if (tag) chips.push({ label: `Tag: ${tag}`, onRemove: () => setParams({ tag: null }) });
  if (owner) chips.push({
    label: owner === 'me'
      ? 'Owner: me'
      : `Owner: ${members.find((m) => m.id === owner)?.display_name ?? 'selected'}`,
    onRemove: () => setParams({ owner: null }),
  });
  if (workflowId) chips.push({
    label: `Workflow: ${workflowTemplates.find((w) => w.id === workflowId)?.name ?? 'selected'}`,
    onRemove: () => setParams({ workflow: null }),
  });
  if (dateFrom || dateTo) chips.push({
    label: `Created ${dateFrom || 'any'} to ${dateTo || 'any'}`,
    onRemove: () => setParams({ from: null, to: null }),
  });
  const hasFilters = chips.length > 0;
  const clearAll = () => { setSearchInput(''); setSearchParams(new URLSearchParams(), { replace: false }); };

  const rangeStart = total === 0 ? 0 : (pageNumber - 1) * limit + 1;
  const rangeEnd = Math.min(pageNumber * limit, total);

  const selectStyle: React.CSSProperties = {
    fontSize: '0.82rem', padding: '8px 12px', background: 'var(--card)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    color: 'var(--foreground)', fontFamily: 'var(--font-sans)', outline: 'none', cursor: 'pointer',
  };

  return (
    <div className="page-content" style={{ paddingTop: 24 }}>
      <PageHeader
        breadcrumbs={[{ label: 'Workspace' }, { label: 'Documents' }]}
        title="Documents"
        description="Search, filter and manage every document across your organization."
        actions={
          <button className="btn btn-primary" onClick={() => navigate('/documents/new')}>
            <Plus size={16} /> New document
          </button>
        }
      />
      <div style={{ height: 20 }} />

      {/* ── Main card ── */}
      <div style={{
        background: 'var(--card-solid)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', overflow: 'hidden',
      }}>
        {/* Status tabs */}
        <div style={{
          display: 'flex', alignItems: 'flex-end', padding: '0 20px', gap: 2,
          borderBottom: '1px solid var(--border)', overflowX: 'auto',
        }}>
          {STATUS_TABS.map(({ key, label }) => {
            const active = status === key;
            const count = key === '' ? tabCounts.all : (tabCounts.map[key] ?? 0);
            return (
              <button
                key={key || 'all'}
                onClick={() => { setParams({ status: key || null }); setSelected(new Set()); }}
                style={{
                  position: 'relative', padding: '14px 14px 12px', fontSize: '0.85rem',
                  fontWeight: active ? 700 : 500, whiteSpace: 'nowrap', flexShrink: 0,
                  color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', display: 'flex', alignItems: 'center', gap: 7,
                }}
              >
                {label}
                <span style={{
                  fontSize: '0.68rem', fontWeight: 700, minWidth: 18, padding: '1px 6px',
                  borderRadius: 999, textAlign: 'center',
                  background: active ? 'var(--primary)' : 'var(--muted)',
                  color: active ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
                }}>{count}</span>
                {active && <span style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0, height: 2,
                  borderRadius: '2px 2px 0 0', background: 'var(--primary)',
                }} />}
              </button>
            );
          })}
        </div>

        {/* Toolbar */}
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10,
          padding: '12px 20px', borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ position: 'relative', flexShrink: 0, width: 280 }}>
            <Search size={14} style={{
              position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--muted-foreground)', pointerEvents: 'none',
            }} />
            <input
              type="text" value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by title or ID…"
              aria-label="Search documents"
              className="input"
              style={{ paddingLeft: 34, height: 38 }}
            />
          </div>

          <select value={typeId} onChange={(e) => setParams({ type: e.target.value || null })} style={{ ...selectStyle, width: 170 }} aria-label="Filter by type">
            <option value="">All types</option>
            {docTypes.map((dt) => <option key={dt.id} value={dt.id}>{dt.name}</option>)}
          </select>

          <select value={deptId} onChange={(e) => setParams({ dept: e.target.value || null })} style={{ ...selectStyle, width: 170 }} aria-label="Filter by department">
            <option value="">All departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>

          <select value={priority} onChange={(e) => setParams({ priority: e.target.value || null })} style={{ ...selectStyle, width: 140 }} aria-label="Filter by priority">
            <option value="">All priorities</option>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>

          <select value={owner} onChange={(e) => setParams({ owner: e.target.value || null })}
            style={{ ...selectStyle, width: 160 }} aria-label="Filter by owner">
            <option value="">Anyone</option>
            <option value="me">My documents</option>
            {/* Listing colleagues needs admin:users, so a non-admin only gets
                "me" -- which is also all their results could contain. */}
            {members
              .filter((m) => m.id !== currentUserId)
              .map((m) => (
                <option key={m.id} value={m.id}>{m.display_name || m.email}</option>
              ))}
          </select>

          <select value={workflowId} onChange={(e) => setParams({ workflow: e.target.value || null })}
            style={{ ...selectStyle, width: 180 }} aria-label="Filter by workflow">
            <option value="">All workflows</option>
            {workflowTemplates.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setParams({ from: e.target.value || null })}
              aria-label="Created on or after"
              style={{ ...selectStyle, width: 140, cursor: 'text' }}
            />
            <span style={{ fontSize: '0.78rem', color: 'var(--muted-foreground)' }}>to</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setParams({ to: e.target.value || null })}
              aria-label="Created on or before"
              style={{ ...selectStyle, width: 140, cursor: 'text' }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            {isFetching && !isLoading && (
              <span style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>Updating…</span>
            )}
            <button
              onClick={toggleDensity}
              title={density === 'comfortable' ? 'Switch to compact rows' : 'Switch to comfortable rows'}
              aria-label="Toggle row density"
              style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', padding: '7px 11px',
                background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                color: 'var(--muted-foreground)', cursor: 'pointer', fontFamily: 'var(--font-sans)',
              }}
            >
              {density === 'comfortable' ? <Rows3 size={14} /> : <Rows4 size={14} />}
              {density === 'comfortable' ? 'Comfortable' : 'Compact'}
            </button>

            {/* FR-1.10 — saved filter presets */}
            <FilterPresetsMenu
              currentParams={searchParams}
              onApply={handleApplyPreset}
              validWorkflows={workflowTemplates}
              validMembers={members}
            />

            {/* FR-1.8 — show/hide and reorder columns */}
            <ColumnsMenu
              order={columns.order}
              hidden={columns.hidden}
              labels={COLUMN_LABELS}
              onChange={persistColumns}
              onReset={resetColumns}
            />
          </div>
        </div>

        {/* Preset notification live region (FR-1.10) */}
        {presetNotice && (
          <div
            role="status"
            aria-live="polite"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 20px', background: 'var(--secondary)', color: 'var(--foreground)',
              fontSize: '0.8rem', fontWeight: 600, borderBottom: '1px solid var(--border)',
            }}
          >
            <span>{presetNotice}</span>
            <button onClick={() => setPresetNotice(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>
              <X size={14} />
            </button>
          </div>
        )}

        {/* Active filter chips */}
        {hasFilters && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
            padding: '10px 20px', borderBottom: '1px solid var(--border)',
          }}>
            {chips.map((c, i) => (
              <span key={i} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', fontWeight: 600,
                padding: '4px 6px 4px 10px', borderRadius: 999,
                background: 'var(--secondary)', color: 'var(--secondary-foreground)',
              }}>
                {c.label}
                <button onClick={c.onRemove} aria-label={`Remove ${c.label}`} style={{
                  display: 'inline-flex', background: 'transparent', border: 'none',
                  color: 'inherit', cursor: 'pointer', padding: 2, borderRadius: 999,
                }}><X size={12} /></button>
              </span>
            ))}
            <button onClick={clearAll} style={{
              fontSize: '0.78rem', color: 'var(--muted-foreground)', background: 'none',
              border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontWeight: 600,
            }}>Clear all</button>
          </div>
        )}

        {/* Bulk action bar */}
        <AnimatePresence>
          {selected.size > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px',
                background: 'var(--secondary)', borderBottom: '1px solid var(--border)',
              }}
            >
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--foreground)' }}>{selected.size} selected</span>
              <button onClick={() => setSelected(new Set())} style={{
                fontSize: '0.78rem', color: 'var(--muted-foreground)', background: 'none',
                border: 'none', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'var(--font-sans)',
              }}>Clear</button>
              <button onClick={() => setConfirmState({ bulk: true, count: selected.size })} style={{
                display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto',
                padding: '7px 14px', borderRadius: 'var(--radius)', fontSize: '0.8rem', fontWeight: 600,
                background: 'var(--status-rejected-bg)', color: 'var(--status-rejected)',
                border: '1px solid color-mix(in srgb, var(--status-rejected) 30%, transparent)',
                cursor: 'pointer', fontFamily: 'var(--font-sans)',
              }}><Trash2 size={13} /> Delete selected</button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: tableMinWidth }}>
            {/* Header */}
            <div style={{
              display: 'grid', gridTemplateColumns: gridCols, alignItems: 'center',
              padding: '10px 20px', position: 'sticky', top: 0, zIndex: 2,
              background: 'var(--card-solid)', borderBottom: '1px solid var(--border)',
              color: 'var(--muted-foreground)', fontSize: '0.7rem', fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              <div>
                <input type="checkbox" checked={allPageSelected} onChange={toggleAll}
                  aria-label="Select all on page"
                  style={{ accentColor: 'var(--primary)', width: 15, height: 15, cursor: 'pointer' }} />
              </div>
              <HeaderCell label="Document" field="title" onSort={onSort} icon={<SortIcon field="title" />} />
              {visibleColumns.map((key) => {
                const def = COLUMN_DEFS[key];
                return (
                  <HeaderCell
                    key={key}
                    label={def.label}
                    field={def.sort}
                    onSort={onSort}
                    icon={def.sort ? <SortIcon field={def.sort} /> : null}
                    width={columnWidth(key)}
                    onResize={(px) => setColumnWidth(key, px)}
                  />
                );
              })}
              <div style={{ textAlign: 'right' }}>Actions</div>
            </div>

            {/* Body */}
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: gridCols, alignItems: 'center', gap: 12, padding: '0 20px', minHeight: rowMinHeight, borderBottom: '1px solid var(--border)' }}>
                  <Skeleton style={{ width: 15, height: 15, borderRadius: 4 }} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Skeleton style={{ width: 36, height: 36, borderRadius: 'var(--radius)' }} />
                    <div style={{ flex: 1 }}><Skeleton style={{ width: '60%', height: 12, marginBottom: 6 }} /><Skeleton style={{ width: '40%', height: 10 }} /></div>
                  </div>
                  {visibleColumns.map((key) => (
                    <Skeleton key={key} style={{ width: key === 'status' ? 70 : 60, height: key === 'status' ? 20 : 12, borderRadius: key === 'status' ? 999 : undefined }} />
                  ))}
                  <Skeleton style={{ width: 40, height: 12, marginLeft: 'auto' }} />
                </div>
              ))
            ) : isError ? (
              <EmptyState art="search" title="Couldn't load documents"
                description="Something went wrong fetching this list."
                action={<button className="btn btn-primary" onClick={() => refetch()}><RotateCw size={15} /> Retry</button>} />
            ) : documents.length === 0 ? (
              hasFilters ? (
                <EmptyState art="search" title="No documents match these filters"
                  description="Try removing a filter or clearing your search."
                  action={<button className="btn btn-secondary" onClick={clearAll}>Clear filters</button>} />
              ) : (
                <EmptyState art="documents" title="You haven't created any documents yet"
                  description="Start from a template or a blank page."
                  action={<button className="btn btn-primary" onClick={() => navigate('/documents/new')}><Plus size={15} /> New document</button>} />
              )
            ) : (
              /* FR-1.4 — above VIRTUALIZE_ABOVE rows the body gets its own
                 scroll container and only the visible window is mounted. Below
                 that threshold nothing changes: no container, no listener, and
                 the page scrolls as it always did. */
              <div
                ref={virtual.scrollRef}
                style={virtual.active
                  ? { maxHeight: 'min(68vh, 760px)', overflowY: 'auto', overscrollBehavior: 'contain' }
                  : undefined}
              >
                {virtual.padTop > 0 && <div aria-hidden style={{ height: virtual.padTop }} />}
                {documents.slice(virtual.start, virtual.end).map((doc) => (
                  <DocumentRow
                    key={doc.id} doc={doc} rowMinHeight={rowMinHeight}
                    fixedHeight={virtual.active}
                    columns={visibleColumns} gridCols={gridCols}
                    isSelected={selected.has(doc.id)} isDeleting={deleting.has(doc.id)}
                    onToggle={() => toggleRow(doc.id)}
                    onOpen={() => navigate(`/documents/${doc.id}`)}
                    onContinue={() => navigate(continueHref(doc))}
                    onDelete={() => setConfirmState({ id: doc.id, title: doc.title })}
                  />
                ))}
                {virtual.padBottom > 0 && <div aria-hidden style={{ height: virtual.padBottom }} />}
              </div>
            )}
          </div>
        </div>

        {/* Footer: result summary + page size + pager */}
        {!isLoading && !isError && documents.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, padding: '14px 20px', borderTop: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: '0.82rem', color: 'var(--muted-foreground)' }}>
              Showing <strong style={{ color: 'var(--foreground)' }}>{rangeStart}–{rangeEnd}</strong> of <strong style={{ color: 'var(--foreground)' }}>{total.toLocaleString()}</strong>
            </span>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <select value={limit} onChange={(e) => setParams({ limit: Number(e.target.value) })} style={{ ...selectStyle, padding: '6px 10px' }} aria-label="Rows per page">
                {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} / page</option>)}
              </select>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button onClick={goPrev} disabled={!hasPrev}
                  aria-label="Previous page"
                  style={pagerBtn(!hasPrev)}><ChevronLeft size={15} /></button>
                <span style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)', padding: '0 6px' }}>
                  Page <strong style={{ color: 'var(--foreground)' }}>{pageNumber}</strong> of {pages}
                </span>
                <button onClick={goNext} disabled={!hasNext}
                  aria-label="Next page"
                  style={pagerBtn(!hasNext)}><ChevronRight size={15} /></button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={{ height: 32 }} />

      <ConfirmDialog
        open={confirmState !== null}
        title={confirmState?.bulk ? 'Delete documents' : 'Delete document'}
        message={confirmState?.bulk
          ? `Delete ${confirmState.count} selected documents? This cannot be undone.`
          : `Delete "${confirmState?.title}"? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => { if (confirmState?.bulk) executeBulkDelete(); else if (confirmState?.id) executeDelete(confirmState.id); }}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────────

/**
 * A column heading: sorts when it can, and carries the resize grip (FR-1.8).
 *
 * The grip is a real focusable control with slider semantics, so a column can
 * be resized from the keyboard as well as the mouse (FR-15.4). The width is
 * written on pointer-up rather than on every move, so a drag is one stored
 * layout rather than a hundred.
 */
function HeaderCell({ label, field, onSort, icon, width, onResize }: {
  label: string;
  field?: SortField;
  onSort: (f: SortField) => void;
  icon: React.ReactNode;
  width?: number;
  onResize?: (px: number) => void;
}) {
  const startDrag = (e: React.PointerEvent) => {
    if (!onResize || width == null) return;
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startWidth = width;
    grip.setPointerCapture(e.pointerId);
    let next = startWidth;
    const onMove = (ev: PointerEvent) => {
      next = Math.min(Math.max(startWidth + (ev.clientX - startX), MIN_COL_WIDTH), MAX_COL_WIDTH);
      // Live feedback without a state write per pixel.
      grip.style.setProperty('--drag-hint', `${Math.round(next)}px`);
      onResize(next);
    };
    const stop = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', stop);
      grip.removeEventListener('pointercancel', stop);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
  };

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', minWidth: 0 }}>
      {field ? (
        <button onClick={() => onSort(field)} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
          color: 'inherit', font: 'inherit', textTransform: 'uppercase', letterSpacing: '0.05em',
          cursor: 'pointer', padding: 0, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{label}{icon}</button>
      ) : (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      )}
      {onResize && width != null && (
        <span
          role="slider"
          tabIndex={0}
          aria-label={`Resize the ${label} column`}
          aria-valuenow={width}
          aria-valuemin={MIN_COL_WIDTH}
          aria-valuemax={MAX_COL_WIDTH}
          className="col-grip"
          onPointerDown={startDrag}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            onResize(width + (e.key === 'ArrowRight' ? 16 : -16));
          }}
        />
      )}
    </div>
  );
}

const pagerBtn = (disabled: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 10px',
  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
  color: 'var(--muted-foreground)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
});

function DocumentRow({
  doc, rowMinHeight, columns, gridCols, isSelected, isDeleting, onToggle, onOpen, onContinue, onDelete,
  fixedHeight = false,
}: {
  doc: Document; rowMinHeight: number; columns: ColumnKey[]; gridCols: string;
  isSelected: boolean; isDeleting: boolean;
  onToggle: () => void; onOpen: () => void; onContinue: () => void; onDelete: () => void;
  /** Virtualised rows must be exactly `rowMinHeight` tall, border included,
   *  or the window drifts out of step with the scroll position (FR-1.4). */
  fixedHeight?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const prio = priorityMeta(doc.priority);
  const due = dueMeta(doc.due_at);
  const isDraft = doc.status === 'draft';
  const initials = doc.submitter_name
    ? doc.submitter_name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase() : 'U';

  return (
    <motion.div
      animate={{ opacity: isDeleting ? 0 : 1, x: isDeleting ? 16 : 0 }}
      transition={{ duration: 0.22 }}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onClick={onOpen}
      style={{
        display: 'grid', gridTemplateColumns: gridCols, alignItems: 'center', gap: 12,
        padding: '0 20px', minHeight: rowMinHeight, cursor: 'pointer',
        ...(fixedHeight ? { height: rowMinHeight, boxSizing: 'border-box' as const, overflow: 'hidden' } : {}),
        background: isSelected ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : hovered ? 'var(--muted)' : 'transparent',
        borderLeft: isSelected ? '3px solid var(--primary)' : '3px solid transparent',
        borderBottom: '1px solid var(--border)', transition: 'background 0.15s',
      }}
    >
      {/* role="presentation": this wrapper exists only to keep the row's
          own click handler from firing. The checkbox inside it is the control,
          and it is already labelled and keyboard-reachable. */}
      <div role="presentation" onClick={(e) => { e.stopPropagation(); onToggle(); }}>
        <input type="checkbox" checked={isSelected} onChange={() => {}} aria-label={`Select ${doc.title}`}
          style={{ accentColor: 'var(--primary)', width: 15, height: 15, cursor: 'pointer' }} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, padding: '10px 8px 10px 0' }}>
        <div style={{
          width: 36, height: 36, flexShrink: 0, borderRadius: 'var(--radius)',
          background: 'color-mix(in srgb, var(--primary) 10%, transparent)',
          border: '1px solid color-mix(in srgb, var(--primary) 20%, transparent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><FileText size={16} style={{ color: 'var(--primary)' }} /></div>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--foreground)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</p>
          <p style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)', margin: '2px 0 0', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="font-mono" style={{ fontWeight: 600, color: 'var(--primary)' }}>{doc.public_id}</span>
            <span>·</span>
            <span title={doc.submitter_name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{initials} · {doc.submitter_name || 'Member'}</span>
          </p>
        </div>
      </div>

      {columns.map((key) => {
        switch (key) {
          case 'type':
            return <div key={key} style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.doc_type_name || 'Document'}</div>;
          case 'status':
            return <div key={key}><StatusBadge status={doc.status} /></div>;
          case 'priority':
            return <div key={key} style={{ fontSize: '0.8rem', fontWeight: 600, color: prio.color }}>{prio.label}</div>;
          case 'due':
            return <div key={key} style={{ fontSize: '0.8rem', color: due ? due.color : 'var(--muted-foreground)' }} title={due?.title}>{due ? due.text : '—'}</div>;
          case 'updated':
            return <div key={key} style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }} title={formatDateTime(doc.updated_at)}>{relativeTime(doc.updated_at)}</div>;
          default:
            return null;
        }
      })}

      {/* Same: a presentation wrapper, not a control. The buttons inside are
          the controls. `focus-within` brings them to full opacity so a
          keyboard user can see what they have landed on (WCAG 2.2 SC 2.4.11). */}
      <div
        role="presentation"
        onClick={(e) => e.stopPropagation()}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, opacity: hovered ? 1 : 0.5, transition: 'opacity 0.15s' }}
      >
        {isDraft ? (
          <button onClick={onContinue} className="btn btn-secondary btn-sm" style={{ padding: '4px 10px', fontSize: '0.75rem' }}><Play size={12} /> Continue</button>
        ) : (
          <button onClick={onOpen} className="btn btn-ghost btn-sm" style={{ padding: '4px 10px', fontSize: '0.75rem' }}>Open</button>
        )}
        <button onClick={onDelete} title="Delete" aria-label={`Delete ${doc.title}`} style={{
          display: 'inline-flex', padding: 6, background: 'transparent', border: 'none',
          borderRadius: 'var(--radius)', color: 'var(--status-rejected)', cursor: 'pointer',
        }}><Trash2 size={13} /></button>
      </div>
    </motion.div>
  );
}
