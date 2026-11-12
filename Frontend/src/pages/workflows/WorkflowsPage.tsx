/**
 * DocFlow Frontend — Workflows page (Workflow module §5.2, WF-LIST-01..07)
 *
 * Two tabs with count badges — My Workflows and Shared with me — and
 * "Archived" as a FILTER within My Workflows rather than a tab of its own,
 * which is what WF-LIST-01 specifies.
 *
 * Every action on a row is real and reaches the server (UX-INT-01): the page
 * it replaced showed a decorative drag handle, a hardcoded three-step
 * pipeline and trend arrows over data it did not have. Row actions are hidden
 * when unavailable, and the server still enforces them (WF-LIST-03).
 *
 * Delete is offered but the server refuses it while runs are in flight
 * (WF-LC-04); the error says so and points at Archive, which is exactly the
 * route WF-LIST-07 asks for.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  Copy,
  Eye,
  GitBranch,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Share2,
  Trash2,
  Users,
} from 'lucide-react';

import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import TabCountBadge from '@/components/ui/TabCountBadge';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import ShareWorkflowDialog from '@/components/workflows/ShareWorkflowDialog';
import { ApiClientError } from '@/lib/api/client';
import { workflowsApi, type WorkflowTemplateSummary } from '@/lib/api/workflows';
import {
  useSetWorkflowArchived,
  useWorkflowsByScope,
  workflowKeys,
} from '@/hooks/useWorkflows';
import { useAuthStore } from '@/store/authStore';

const C = {
  card: 'var(--bg-elevated)',
  overlay: 'var(--bg-overlay)',
  border: 'var(--border-default)',
  borderSubtle: 'var(--border-subtle)',
  primary: 'var(--color-primary-400)',
  success: 'var(--color-success-400)',
  warning: 'var(--color-warning-400)',
  danger: 'var(--color-error-400)',
  heading: 'var(--text-primary)',
  body: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
};

type Tab = 'mine' | 'shared';

function Chip({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'primary' | 'warning' | 'success' }) {
  const color =
    tone === 'primary' ? C.primary : tone === 'warning' ? C.warning : tone === 'success' ? C.success : C.muted;
  return (
    <span
      style={{
        // inline-flex so a chip with an icon keeps it on the text's line:
        // Tailwind's preflight makes svg display:block.
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 22%, transparent)`,
        borderRadius: 999,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function RowMenu({ items }: { items: { label: string; icon: React.ElementType; run: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Workflow actions"
        aria-expanded={open}
        style={{
          width: 44,
          height: 44,
          display: 'grid',
          placeItems: 'center',
          background: 'transparent',
          border: `1px solid ${C.borderSubtle}`,
          borderRadius: 9,
          color: C.muted,
          cursor: 'pointer',
        }}
      >
        <MoreVertical size={15} aria-hidden />
      </button>
      {open ? (
        <>
          <div
            role="presentation"
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
          />
          <div
            role="menu"
            style={{
              position: 'absolute',
              right: 0,
              top: 48,
              zIndex: 41,
              minWidth: 184,
              background: 'var(--popover, var(--bg-elevated))',
              border: `1px solid ${C.border}`,
              borderRadius: 11,
              boxShadow: 'var(--shadow-lg)',
              overflow: 'hidden',
            }}
          >
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  it.run();
                }}
                style={{
                  width: '100%',
                  minHeight: 44,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '0 13px',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  textAlign: 'left',
                  color: it.danger ? C.danger : C.body,
                }}
              >
                <it.icon size={14} aria-hidden /> {it.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const myUserId = useAuthStore((s) => s.user?.id) ?? null;

  const [tab, setTab] = useState<Tab>('mine');
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [shareFor, setShareFor] = useState<WorkflowTemplateSummary | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<WorkflowTemplateSummary | null>(null);

  // Archived rows are only fetched when the filter asks for them, so the
  // default list is the active set (WF-LIST-01).
  const mine = useWorkflowsByScope('mine', { activeOnly: !showArchived });
  const shared = useWorkflowsByScope('shared', { activeOnly: false });

  const archiveM = useSetWorkflowArchived();
  const duplicateM = useMutation({
    mutationFn: (id: string) => workflowsApi.duplicateWorkflow(id),
    onSuccess: () => {
      toast.success('Workflow duplicated — the copy is private to you');
      queryClient.invalidateQueries({ queryKey: workflowKeys.all });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => workflowsApi.deleteWorkflow(id),
    onSuccess: () => {
      toast.success('Workflow deleted');
      queryClient.invalidateQueries({ queryKey: workflowKeys.all });
    },
    onError: (err: unknown) => {
      // WF-LC-04 / WF-LIST-07: the server explains that in-flight runs block
      // this and that archiving is the way through. Show its words.
      toast.error(
        err instanceof ApiClientError ? err.detail : 'Could not delete this workflow',
      );
    },
  });

  const rows = useMemo(() => {
    const list = (tab === 'mine' ? mine.data : shared.data) ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        (w.description ?? '').toLowerCase().includes(q),
    );
  }, [tab, mine.data, shared.data, search]);

  const loading = tab === 'mine' ? mine.isLoading : shared.isLoading;
  const error = tab === 'mine' ? mine.error : shared.error;

  function onDelete(wf: WorkflowTemplateSummary) {
    setConfirmDelete(wf);
  }

  const tabs = (
    <div style={{ display: 'flex', gap: 6 }}>
      {(
        [
          ['mine', 'My Workflows', mine.data?.length ?? 0],
          ['shared', 'Shared with me', shared.data?.length ?? 0],
        ] as const
      ).map(([key, label, count]) => {
        const active = tab === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-current={active ? 'page' : undefined}
            style={{
              minHeight: 44,
              padding: '0 14px',
              borderRadius: 10,
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              color: active ? C.heading : C.muted,
              background: active ? C.card : 'transparent',
              boxShadow: active ? 'var(--shadow-md)' : 'none',
            }}
          >
            {label}
            <TabCountBadge count={count} active={active} />
          </button>
        );
      })}
    </div>
  );

  return (
    /* `page-content` is the app's page gutter (index.css: 32px, 16px on
       mobile) and every other page uses it. Without it this page rendered
       flush against the viewport edge and the sidebar, which is what made
       the module look unaligned next to Documents and Approvals. The column
       cap matches Drafts, so a row never stretches to 1400px. */
    <div className="page-content" style={{ paddingTop: 24, maxWidth: 1040, margin: '0 auto' }}>
      <PageHeader
        title="Workflows"
        description="Reusable approval routes for your documents."
        tabs={tabs}
        actions={
          <button
            type="button"
            onClick={() => navigate('/workflows/new')}
            style={{
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 10,
              border: 'none',
              background: C.primary,
              color: 'var(--color-primary-foreground, #fff)',
              fontWeight: 700,
              fontSize: 13.5,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
            }}
          >
            <Plus size={15} aria-hidden /> New Workflow
          </button>
        }
      />

      {/* Search + archived filter — WF-LIST-04 / WF-LIST-01 */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          flexWrap: 'wrap',
          // The tab row above ended flush on this row, so the active tab's
          // surface ran straight into the search field.
          marginTop: 16,
          marginBottom: 16,
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: '1 1 240px',
            // Capped: an 850px search box pushed "Show archived" to the far
            // edge, away from the list it filters.
            maxWidth: 420,
            background: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            padding: '0 12px',
            minHeight: 44,
          }}
        >
          <Search size={15} color={C.muted} aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search workflows"
            aria-label="Search workflows"
            style={{
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: C.heading,
              fontSize: 13.5,
            }}
          />
        </label>

        {tab === 'mine' ? (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minHeight: 44,
              fontSize: 13,
              color: C.body,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
        ) : null}
      </div>

      {/* States — WF-LIST-06 */}
      {loading ? (
        <div style={{ display: 'grid', gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} style={{ height: 86, borderRadius: 14 }} />
          ))}
        </div>
      ) : error ? (
        <EmptyState
          art="workflow"
          title="Could not load workflows"
          description={
            error instanceof ApiClientError ? error.detail : 'Something went wrong.'
          }
          action={
            <button
              type="button"
              onClick={() =>
                queryClient.invalidateQueries({ queryKey: workflowKeys.all })
              }
              style={{
                minHeight: 44,
                padding: '0 16px',
                borderRadius: 10,
                border: `1px solid ${C.border}`,
                background: C.overlay,
                color: C.heading,
                cursor: 'pointer',
                fontWeight: 700,
              }}
            >
              Retry
            </button>
          }
        />
      ) : rows.length === 0 ? (
        tab === 'mine' ? (
          <EmptyState
            art="workflow"
            title={search ? 'No workflows match that search' : 'Create your first workflow'}
            description={
              search
                ? 'Try a different name.'
                : 'A workflow is the ordered list of people who approve your documents.'
            }
            action={
              search ? undefined : (
                <button
                  type="button"
                  onClick={() => navigate('/workflows/new')}
                  style={{
                    minHeight: 44,
                    padding: '0 16px',
                    borderRadius: 10,
                    border: 'none',
                    background: C.primary,
                    color: 'var(--color-primary-foreground, #fff)',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  New Workflow
                </button>
              )
            }
          />
        ) : (
          <EmptyState
            art="people"
            title="Nothing shared with you yet"
            description="Workflows shared with you will appear here."
          />
        )
      ) : (
        <ul style={{ display: 'grid', gap: 10, margin: 0, padding: 0, listStyle: 'none' }}>
          {rows.map((wf) => {
            const isOwner = wf.created_by === myUserId;
            const archived = !wf.is_active;
            const menu: { label: string; icon: React.ElementType; run: () => void; danger?: boolean }[] = [
              { label: 'View', icon: Eye, run: () => navigate(`/workflows/${wf.id}`) },
            ];
            if (isOwner) {
              menu.push({
                label: 'Edit',
                icon: Pencil,
                run: () => navigate(`/workflows/${wf.id}/edit`),
              });
            }
            menu.push({
              label: 'Duplicate',
              icon: Copy,
              run: () => duplicateM.mutate(wf.id),
            });
            if (isOwner) {
              menu.push({
                label: 'Share',
                icon: Share2,
                run: () => setShareFor(wf),
              });
              menu.push({
                label: archived ? 'Restore' : 'Archive',
                icon: archived ? ArchiveRestore : Archive,
                run: () =>
                  archiveM.mutate(
                    { templateId: wf.id, archived: !archived },
                    {
                      onSuccess: () =>
                        toast.success(archived ? 'Workflow restored' : 'Workflow archived'),
                      onError: (e: Error) => toast.error(e.message),
                    },
                  ),
              });
              menu.push({
                label: 'Delete',
                icon: Trash2,
                run: () => onDelete(wf),
                danger: true,
              });
            }

            return (
              <li
                key={wf.id}
                style={{
                  background: C.card,
                  border: `1px solid ${C.border}`,
                  borderRadius: 14,
                  padding: 15,
                  display: 'flex',
                  gap: 13,
                  alignItems: 'flex-start',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 38,
                    height: 38,
                    flexShrink: 0,
                    borderRadius: 11,
                    display: 'grid',
                    placeItems: 'center',
                    background: `color-mix(in srgb, ${C.primary} 12%, transparent)`,
                  }}
                >
                  <GitBranch size={17} color={C.primary} />
                </span>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <button
                    type="button"
                    onClick={() => navigate(`/workflows/${wf.id}`)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontSize: 14.5,
                      fontWeight: 700,
                      color: C.heading,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {wf.name}
                  </button>

                  {wf.description ? (
                    <p
                      title={wf.description}
                      style={{
                        margin: '4px 0 0',
                        fontSize: 12.5,
                        color: C.muted,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {wf.description}
                    </p>
                  ) : null}

                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
                    <Chip tone={archived ? 'muted' : 'success'}>
                      {archived ? 'Archived' : 'Active'}
                    </Chip>
                    <Chip tone={wf.visibility === 'private' ? 'muted' : 'primary'}>
                      {wf.visibility === 'private' ? 'Private' : 'Organization'}
                    </Chip>
                    <Chip>v{wf.version}</Chip>
                    {tab === 'shared' ? (
                      <Chip tone="primary">
                        <Users size={10} aria-hidden /> Shared with you
                      </Chip>
                    ) : null}
                  </div>
                </div>

                <RowMenu items={menu} />
              </li>
            );
          })}
        </ul>
      )}

      {shareFor ? (
        <ShareWorkflowDialog
          templateId={shareFor.id}
          workflowName={shareFor.name}
          ownerId={shareFor.created_by}
          onClose={() => setShareFor(null)}
        />
      ) : null}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete this workflow?"
        message={
          confirmDelete
            ? `“${confirmDelete.name}” will be removed from your list and anyone it is shared with loses access. Documents already approved keep their history. If any document is still in approval the server will refuse — archive it instead.`
            : ''
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmDelete) deleteM.mutate(confirmDelete.id);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
