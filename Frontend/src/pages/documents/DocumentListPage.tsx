/**
 * DocFlow Frontend — Page: DocumentListPage (/documents)
 * Rich document repository with lifecycle status tabs, stat strip,
 * checkbox bulk selection, animated table rows, search/filter, and pagination.
 * UI adapted from the Figma/Make prototype — connected to real data hooks.
 * Styling: 100% inline styles (no Tailwind classes for layout/spacing) to avoid
 * Tailwind v4 @theme inline directive interference.
 */

import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText,
  Plus,
  Search,
  Trash2,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Clock,
  CheckCircle2,
  FileStack,
  MoreHorizontal,
} from 'lucide-react';
import {
  useDocuments,
  useDocumentTypes,
  useDeleteDocument,
} from '@/hooks/useDocuments';
import { useDepartments } from '@/hooks/useOrg';
import type { Document, DocumentStatus } from '@/types';
import { formatDate } from '@/lib/utils/date';
import TabCountBadge from '@/components/ui/TabCountBadge';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

// ── Status tab definitions ────────────────────────────────────────────────────

type TabKey = '' | DocumentStatus;

const STATUS_TABS: { key: TabKey; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'under_review', label: 'Under Review' },
  { key: 'pending_approval', label: 'Pending Approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'archived', label: 'Archived' },
];

// ── Badge helpers ─────────────────────────────────────────────────────────────

function getStatusStyle(status: string): { color: string; bg: string; label: string } {
  switch (status) {
    case 'approved':
      return { label: 'Approved', bg: 'hsla(145, 70%, 50%, 0.15)', color: 'var(--color-success-400)' };
    case 'under_review':
    case 'in_review':
      return { label: 'Under Review', bg: 'hsla(258, 90%, 60%, 0.15)', color: 'var(--color-accent-400)' };
    case 'submitted':
      return { label: 'Submitted', bg: 'hsla(217, 100%, 50%, 0.15)', color: 'var(--color-primary-300)' };
    case 'pending_approval':
      return { label: 'Pending Approval', bg: 'hsla(38, 92%, 55%, 0.15)', color: 'var(--color-warning-400)' };
    case 'rejected':
      return { label: 'Rejected', bg: 'hsla(0, 82%, 60%, 0.15)', color: 'var(--color-error-400)' };
    case 'archived':
      return { label: 'Archived', bg: 'hsla(215, 20%, 50%, 0.15)', color: 'var(--text-muted)' };
    case 'draft':
    default:
      return { label: 'Draft', bg: 'hsla(38, 92%, 50%, 0.15)', color: 'var(--color-warning-400)' };
  }
}

function getPriorityStyle(priority: string): { label: string; color: string } {
  switch (priority) {
    case 'urgent': return { label: '🔥 Urgent', color: 'var(--color-error-400)' };
    case 'high':   return { label: '⚡ High',   color: 'var(--color-warning-400)' };
    case 'low':    return { label: '💤 Low',    color: 'var(--text-muted)' };
    default:       return { label: '• Normal',  color: 'var(--color-primary-300)' };
  }
}

// ── Status Badge component ────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const s = getStatusStyle(status);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 10px',
        borderRadius: 'var(--radius-full)',
        fontSize: '0.72rem',
        fontWeight: 700,
        color: s.color,
        background: s.bg,
        whiteSpace: 'nowrap',
      }}
    >
      {s.label}
    </span>
  );
}

// ── Grid template shared between header and rows ──────────────────────────────

const GRID_COLS = '40px minmax(200px,1fr) 120px 160px 100px 130px 90px';

// ── Document Row ──────────────────────────────────────────────────────────────

function DocumentRow({
  doc,
  isSelected,
  isDeleting,
  onSelect,
  onOpen,
  onDelete,
}: {
  doc: Document;
  isSelected: boolean;
  isDeleting: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const priority = getPriorityStyle(doc.priority);

  const initials = doc.submitter_name
    ? doc.submitter_name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
    : 'U';

  return (
    <motion.div
      animate={{ opacity: isDeleting ? 0 : 1, x: isDeleting ? 20 : 0 }}
      transition={{ duration: 0.25 }}
      style={{
        display: 'grid',
        gridTemplateColumns: GRID_COLS,
        alignItems: 'center',
        padding: '0 24px',
        minHeight: 72,
        cursor: 'pointer',
        background: isSelected
          ? 'hsla(217, 100%, 50%, 0.08)'
          : hovered
          ? 'var(--bg-overlay)'
          : 'transparent',
        borderLeft: isSelected
          ? '3px solid var(--color-primary-500)'
          : '3px solid transparent',
        borderBottom: '1px solid var(--border-subtle)',
        transition: 'background 0.15s, border-color 0.15s',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onOpen}
    >
      {/* Checkbox */}
      <div onClick={onSelect}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => {}}
          style={{ accentColor: 'var(--color-primary-500)', width: 15, height: 15, cursor: 'pointer' }}
        />
      </div>

      {/* Document title + public_id + submitter */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '16px 16px 16px 0', minWidth: 0,
      }}>
        <div
          style={{
            width: 40, height: 40, flexShrink: 0,
            borderRadius: 'var(--radius-md)',
            background: 'hsla(217, 100%, 50%, 0.1)',
            border: '1px solid hsla(217, 100%, 50%, 0.2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <FileText size={17} style={{ color: 'var(--color-primary-400)' }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <p
            style={{
              fontSize: '0.875rem',
              fontWeight: 700,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              margin: 0,
            }}
          >
            {doc.title}
          </p>
          <p
            style={{
              fontSize: '0.72rem',
              color: 'var(--text-muted)',
              marginTop: '2px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              margin: '2px 0 0',
            }}
          >
            <span
              style={{
                fontFamily: 'monospace',
                fontWeight: 700,
                color: 'var(--color-primary-400)',
                background: 'hsla(217, 100%, 50%, 0.1)',
                padding: '1px 6px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {doc.public_id}
            </span>
            <span>·</span>
            <span
              style={{
                width: 16, height: 16, borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--color-primary-500), var(--color-accent-500))',
                color: '#fff',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.6rem', fontWeight: 700, flexShrink: 0,
              }}
            >
              {initials}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {doc.submitter_name || 'Member'}
            </span>
          </p>
        </div>
      </div>

      {/* Type */}
      <div>
        <span
          style={{
            fontSize: '0.78rem',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            background: 'var(--bg-overlay)',
            padding: '3px 8px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          {doc.doc_type_name || 'Document'}
        </span>
      </div>

      {/* Status */}
      <div>
        <StatusBadge status={doc.status} />
      </div>

      {/* Priority */}
      <div style={{ fontSize: '0.82rem', fontWeight: 700, color: priority.color }}>
        {priority.label}
      </div>

      {/* Updated */}
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
        {formatDate(doc.updated_at)}
        {doc.comment_count !== undefined && doc.comment_count > 0 && (
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
            💬 {doc.comment_count}
          </div>
        )}
      </div>

      {/* Actions */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          opacity: hovered ? 1 : 0.4, transition: 'opacity 0.15s',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          style={{
            fontSize: '0.75rem', padding: '4px 10px',
            background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)',
            cursor: 'pointer', fontFamily: 'var(--font-sans)',
          }}
        >
          Open
        </button>
        <button
          onClick={onDelete}
          style={{
            fontSize: '0.75rem', padding: '4px 8px',
            background: 'transparent', border: 'none',
            borderRadius: 'var(--radius-md)', color: 'var(--color-error-400)',
            cursor: 'pointer',
          }}
          title="Delete"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </motion.div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  color,
  bg,
  trend,
  up,
}: {
  icon: React.ComponentType<{ size: number; style?: React.CSSProperties }>;
  label: string;
  value: number | string;
  color: string;
  bg: string;
  trend: string;
  up: boolean;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 16,
        padding: 20,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
        <div
          style={{
            width: 36, height: 36,
            borderRadius: 'var(--radius-md)',
            background: bg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Icon size={17} style={{ color }} />
        </div>
        <span
          style={{
            fontSize: '0.75rem', fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 2,
            color: up ? 'var(--color-success-400)' : 'var(--color-error-400)',
          }}
        >
          {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
          {trend}
        </span>
      </div>
      <p style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1, margin: 0 }}>
        {value}
      </p>
      <p style={{ fontSize: '0.72rem', marginTop: '6px', color: 'var(--text-muted)', margin: '6px 0 0' }}>{label}</p>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const PER_PAGE = 10;

export default function DocumentListPage() {
  const navigate = useNavigate();

  // Filter state
  const [activeTab, setActiveTab] = useState<TabKey>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTypeId, setSelectedTypeId] = useState('');
  const [selectedDeptId, setSelectedDeptId] = useState('');
  const [page, setPage] = useState(1);

  // Selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  
  // Dialog state
  const [confirmState, setConfirmState] = useState<{ id?: string; title?: string; bulk?: boolean; count?: number } | null>(null);

  // Queries
  const { data: docData, isLoading } = useDocuments({
    page,
    limit: PER_PAGE,
    status: activeTab || undefined,
    doc_type_id: selectedTypeId || undefined,
    dept_id: selectedDeptId || undefined,
    search: searchQuery || undefined,
  });

  const { data: docTypes = [] } = useDocumentTypes(true);
  const { data: departments = [] } = useDepartments(true);
  const deleteDoc = useDeleteDocument();

  const documents = docData?.items || [];
  const total = docData?.total || 0;
  const pages = Math.max(1, docData?.pages || 1);

  // Counts for stat cards (from current full list)
  const allDocs = useDocuments({ page: 1, limit: 1000 });
  const allItems = allDocs.data?.items || [];
  const statCounts = useMemo(() => ({
    total: allDocs.data?.total || 0,
    draft: allItems.filter((d) => d.status === 'draft').length,
    inReview: allItems.filter((d) => ['submitted', 'under_review', 'pending_approval'].includes(d.status)).length,
    approved: allItems.filter((d) => d.status === 'approved').length,
  }), [allItems, allDocs.data]);

  const tabCounts = useMemo(() => {
    const counts = { '': allItems.length } as Record<TabKey, number>;
    allItems.forEach(doc => {
      counts[doc.status as TabKey] = (counts[doc.status as TabKey] || 0) + 1;
    });
    return counts;
  }, [allItems]);

  // Tab switching
  function switchTab(tab: TabKey) {
    setActiveTab(tab);
    setSelected(new Set());
    setPage(1);
  }

  // Selection
  function toggleRow(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === documents.length ? new Set() : new Set(documents.map((d) => d.id))
    );
  }

  const allPageSelected = documents.length > 0 && selected.size >= documents.length;

  // Delete single
  function handleDeleteClick(e: React.MouseEvent, doc: Document) {
    e.stopPropagation();
    setConfirmState({ id: doc.id, title: doc.title });
  }

  async function executeDelete(id: string) {
    setConfirmState(null);
    setDeleting((prev) => new Set(prev).add(id));
    setTimeout(async () => {
      try {
        await deleteDoc.mutateAsync(id);
      } finally {
        setDeleting((prev) => { const n = new Set(prev); n.delete(id); return n; });
        setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
      }
    }, 260);
  }

  // Bulk delete
  function handleBulkDeleteClick() {
    setConfirmState({ bulk: true, count: selected.size });
  }

  async function executeBulkDelete() {
    setConfirmState(null);
    const ids = [...selected];
    setSelected(new Set());
    for (const id of ids) {
      try { await deleteDoc.mutateAsync(id); } catch { /* continue */ }
    }
  }

  return (
    <div style={{ padding: '32px', maxWidth: '1440px', margin: '0 auto' }}>

      {/* ── Page Header ── */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        marginBottom: 24, flexWrap: 'wrap', gap: 16,
      }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.2, margin: 0 }}>
            Document Repository
          </h1>
          <p style={{ color: 'var(--text-muted)', marginTop: '6px', fontSize: '0.9rem', margin: '6px 0 0' }}>
            Search, filter, and manage document lifecycle across your organization.
          </p>
        </div>
        <button
          onClick={() => navigate('/documents/new')}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 20px', borderRadius: 'var(--radius-md)',
            background: 'linear-gradient(135deg, var(--color-primary-500), var(--color-primary-600))',
            color: '#fff', border: 'none', cursor: 'pointer',
            fontSize: '0.875rem', fontWeight: 600, fontFamily: 'var(--font-sans)',
          }}
        >
          <Plus size={16} />
          New Document
        </button>
      </div>

      {/* ── Stat Strip ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 16,
        marginBottom: 24,
      }}>
        <StatCard
          icon={FileStack}
          label="Total Documents"
          value={statCounts.total}
          color="var(--color-primary-400)"
          bg="hsla(217, 100%, 50%, 0.1)"
          trend="+this month"
          up={true}
        />
        <StatCard
          icon={Clock}
          label="Draft"
          value={statCounts.draft}
          color="var(--color-warning-400)"
          bg="hsla(38, 92%, 55%, 0.1)"
          trend="awaiting submission"
          up={false}
        />
        <StatCard
          icon={FileText}
          label="Under Review"
          value={statCounts.inReview}
          color="var(--color-accent-400)"
          bg="hsla(258, 90%, 60%, 0.1)"
          trend="in progress"
          up={true}
        />
        <StatCard
          icon={CheckCircle2}
          label="Approved"
          value={statCounts.approved}
          color="var(--color-success-400)"
          bg="hsla(145, 70%, 50%, 0.1)"
          trend="completed"
          up={true}
        />
      </div>

      {/* ── Main Card ── */}
      <div
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 16,
          overflow: 'hidden',
        }}
      >
        {/* Status Tabs */}
        <div
          style={{
            display: 'flex', alignItems: 'flex-end',
            padding: '0 24px',
            borderBottom: '1px solid var(--border-subtle)',
            overflowX: 'auto',
          }}
        >
          {STATUS_TABS.map(({ key, label }) => {
            const active = activeTab === key;
            return (
              <button
                key={key}
                onClick={() => switchTab(key)}
                style={{
                  position: 'relative',
                  padding: '16px 16px 14px',
                  fontSize: '0.875rem', fontWeight: 500,
                  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  flexShrink: 0,
                  display: 'flex', alignItems: 'center',
                  whiteSpace: 'nowrap',
                  fontFamily: 'var(--font-sans)',
                  transition: 'color 0.15s',
                }}
              >
                {label}
                <TabCountBadge count={tabCounts[key] || 0} active={active} />
                {active && (
                  <span
                    style={{
                      position: 'absolute', bottom: 0, left: 0, right: 0,
                      height: 2, borderRadius: '2px 2px 0 0',
                      background: 'var(--color-primary-500)',
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Toolbar */}
        <div
          style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12,
            padding: '12px 24px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          {/* Search */}
          <div style={{ position: 'relative', flexShrink: 0, width: 280 }}>
            <Search
              size={14}
              style={{
                position: 'absolute', left: 12, top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-muted)', pointerEvents: 'none',
              }}
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
              placeholder="Search by title or ID..."
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '8px 14px 8px 36px',
                background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-md)', color: 'var(--text-primary)',
                fontSize: '0.85rem', fontFamily: 'var(--font-sans)',
                outline: 'none',
              }}
            />
          </div>

          {/* Document Type filter */}
          <select
            value={selectedTypeId}
            onChange={(e) => { setSelectedTypeId(e.target.value); setPage(1); }}
            style={{
              width: 180, fontSize: '0.82rem',
              padding: '8px 12px',
              background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-md)', color: 'var(--text-primary)',
              fontFamily: 'var(--font-sans)', outline: 'none', cursor: 'pointer',
            }}
          >
            <option value="">All Types</option>
            {docTypes.map((dt) => (
              <option key={dt.id} value={dt.id}>{dt.name}</option>
            ))}
          </select>

          {/* Department filter */}
          <select
            value={selectedDeptId}
            onChange={(e) => { setSelectedDeptId(e.target.value); setPage(1); }}
            style={{
              width: 180, fontSize: '0.82rem',
              padding: '8px 12px',
              background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-md)', color: 'var(--text-primary)',
              fontFamily: 'var(--font-sans)', outline: 'none', cursor: 'pointer',
            }}
          >
            <option value="">All Departments</option>
            {departments.map((dep) => (
              <option key={dep.id} value={dep.id}>{dep.name}</option>
            ))}
          </select>

          {/* Clear filters */}
          {(searchQuery || selectedTypeId || selectedDeptId || activeTab) && (
            <button
              onClick={() => {
                setSearchQuery(''); setSelectedTypeId('');
                setSelectedDeptId(''); setActiveTab(''); setPage(1);
              }}
              style={{
                fontSize: '0.8rem', color: 'var(--text-muted)',
                background: 'none', border: 'none',
                cursor: 'pointer', fontFamily: 'var(--font-sans)',
              }}
            >
              ✕ Clear
            </button>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            <button
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: '0.8rem', padding: '7px 12px',
                background: 'transparent', border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)', color: 'var(--text-muted)',
                cursor: 'pointer', fontFamily: 'var(--font-sans)',
              }}
            >
              <ArrowUpDown size={13} />
              Newest first
            </button>
          </div>
        </div>

        {/* Bulk Action Bar */}
        <AnimatePresence>
          {selected.size > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.15 }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 24px',
                background: 'var(--bg-overlay)',
                borderLeft: '4px solid var(--color-primary-500)',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                {selected.size} selected
              </span>
              <button
                onClick={() => setSelected(new Set())}
                style={{
                  fontSize: '0.78rem', color: 'var(--text-muted)',
                  background: 'none', border: 'none',
                  cursor: 'pointer', textDecoration: 'underline',
                  fontFamily: 'var(--font-sans)',
                }}
              >
                Clear
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
                <button
                  onClick={handleBulkDeleteClick}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '7px 14px', borderRadius: 'var(--radius-md)',
                    background: 'hsla(0, 82%, 55%, 0.15)', color: 'var(--color-error-400)',
                    border: '1px solid hsla(0, 82%, 55%, 0.3)',
                    cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  <Trash2 size={13} />
                  Delete Selected
                </button>
                <button
                  style={{
                    width: 34, height: 34, borderRadius: 'var(--radius-md)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'transparent', border: '1px solid var(--border-subtle)',
                    color: 'var(--text-muted)', cursor: 'pointer',
                  }}
                >
                  <MoreHorizontal size={15} />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 960 }}>
            {/* Table Header */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: GRID_COLS,
                alignItems: 'center',
                padding: '12px 24px',
                color: 'var(--text-muted)',
                fontSize: '0.72rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <div>
                <input
                  type="checkbox"
                  checked={allPageSelected}
                  onChange={toggleAll}
                  style={{ accentColor: 'var(--color-primary-500)', width: 15, height: 15, cursor: 'pointer' }}
                />
              </div>
              <div>Document</div>
              <div>Type</div>
              <div>Status</div>
              <div>Priority</div>
              <div>Updated</div>
              <div>Actions</div>
            </div>

            {/* Rows */}
            <div>
              {isLoading ? (
                <div style={{ padding: '64px', textAlign: 'center' }}>
                  <div className="spinner" style={{ width: '32px', height: '32px', margin: '0 auto' }} />
                </div>
              ) : documents.length === 0 ? (
                <div style={{
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  gap: 16, padding: '64px 32px', textAlign: 'center',
                  minHeight: 300,
                }}>
                  <div style={{
                    width: 56, height: 56, borderRadius: 'var(--radius-lg)',
                    background: 'hsla(217, 100%, 50%, 0.08)',
                    border: '1px solid hsla(217, 100%, 50%, 0.2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <FileText size={24} style={{ color: 'var(--color-primary-400)' }} />
                  </div>
                  <div>
                    <p style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
                      No documents found
                    </p>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      {searchQuery || selectedTypeId || selectedDeptId || activeTab
                        ? 'Try adjusting your filters or search query.'
                        : 'Create your first document to get started.'}
                    </p>
                  </div>
                  {!searchQuery && !selectedTypeId && !selectedDeptId && !activeTab && (
                    <button
                      onClick={() => navigate('/documents/new')}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '8px 16px', borderRadius: 'var(--radius-md)',
                        background: 'linear-gradient(135deg, var(--color-primary-500), var(--color-primary-600))',
                        color: '#fff', border: 'none', cursor: 'pointer',
                        fontSize: '0.8rem', fontWeight: 600, fontFamily: 'var(--font-sans)',
                      }}
                    >
                      <Plus size={14} /> New Document
                    </button>
                  )}
                </div>
              ) : (
                documents.map((doc) => (
                  <DocumentRow
                    key={doc.id}
                    doc={doc}
                    isSelected={selected.has(doc.id)}
                    isDeleting={deleting.has(doc.id)}
                    onSelect={(e) => toggleRow(doc.id, e)}
                    onOpen={() => navigate(`/documents/${doc.id}`)}
                    onDelete={(e) => handleDeleteClick(e, doc)}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {/* Pagination Footer */}
        {pages > 1 && (
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '16px 24px',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Showing {documents.length} of <strong>{total}</strong> documents — Page{' '}
              <strong>{page}</strong> of <strong>{pages}</strong>
            </span>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '6px 10px',
                  background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)', color: 'var(--text-muted)',
                  cursor: page <= 1 ? 'not-allowed' : 'pointer',
                  opacity: page <= 1 ? 0.4 : 1,
                }}
              >
                <ChevronLeft size={15} />
              </button>

              {Array.from({ length: Math.min(7, pages) }, (_, i) => {
                const n = i + 1;
                return (
                  <button
                    key={n}
                    onClick={() => setPage(n)}
                    style={{
                      minWidth: 36, height: 36,
                      borderRadius: 'var(--radius-md)',
                      fontSize: '0.8rem', fontWeight: 600,
                      background: page === n ? 'var(--color-primary-500)' : 'transparent',
                      color: page === n ? '#fff' : 'var(--text-muted)',
                      border: page === n ? 'none' : '1px solid var(--border-subtle)',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                      transition: 'all 0.15s',
                    }}
                  >
                    {n}
                  </button>
                );
              })}

              <button
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                disabled={page >= pages}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '6px 10px',
                  background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)', color: 'var(--text-muted)',
                  cursor: page >= pages ? 'not-allowed' : 'pointer',
                  opacity: page >= pages ? 0.4 : 1,
                }}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom breathing room */}
      <div style={{ height: 32 }} />

      {/* Confirm Dialog */}
      <ConfirmDialog
        open={confirmState !== null}
        title={confirmState?.bulk ? 'Delete Multiple Documents' : 'Delete Document'}
        message={
          confirmState?.bulk
            ? `Are you sure you want to delete ${confirmState.count} selected documents? This cannot be undone.`
            : `Are you sure you want to delete "${confirmState?.title}"? This cannot be undone.`
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmState?.bulk) {
            executeBulkDelete();
          } else if (confirmState?.id) {
            executeDelete(confirmState.id);
          }
        }}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}
