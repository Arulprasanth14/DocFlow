/**
 * DocFlow Frontend — Drafts page (§11)
 *
 * "Drafts provides a dedicated place to save unfinished documents and
 *  return to them later."
 *
 * Lists real draft documents from the backend (status=draft, owned by the
 * caller), with title, type, last-updated time, owner and status. A draft
 * never appears as an approval item until the user explicitly submits it,
 * which is enforced server-side — submitting goes through the normal
 * document submit flow, not a shortcut from this page.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileEdit, Trash2, Send, Clock, AlertCircle, Plus, Sparkles, FileText,
} from 'lucide-react';
import { documentsApi } from '@/lib/api/documents';
import { useAuthStore } from '@/store/authStore';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { IconChip } from '@/components/ui/IconChip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';

const C = {
  card: 'var(--bg-elevated)',
  overlay: 'var(--bg-overlay)',
  border: 'var(--border-default)',
  borderSubtle: 'var(--border-subtle)',
  primary400: 'var(--color-primary-400)',
  success: 'var(--color-success-400)',
  warning: 'var(--color-warning-400)',
  danger: 'var(--color-error-400)',
  heading: 'var(--text-primary)',
  body: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
  disabled: 'var(--text-disabled)',
};

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function DraftsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['documents', 'drafts', userId],
    // Scoped to the caller's own drafts — a draft is private to its author
    // until it's submitted.
    queryFn: () =>
      documentsApi.listDocuments({
        status: 'draft',
        submitted_by: userId,
        limit: 50,
      }),
    enabled: !!userId,
  });

  const { data: typesData } = useQuery({
    queryKey: ['documentTypes'],
    queryFn: () => documentsApi.listDocumentTypes(true),
    staleTime: 60_000,
  });
  const typeName = (id: string) =>
    (typesData ?? []).find((t) => t.id === id)?.name ?? 'Document';

  const deleteM = useMutation({
    mutationFn: (id: string) => documentsApi.deleteDocument(id),
    onSuccess: () => {
      setConfirmId(null);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ['documents', 'drafts'] });
    },
    onError: (e: Error) => setActionError(e.message),
  });

  const drafts = data?.items ?? [];

  return (
    <div className="page-content" style={{ paddingTop: 24, maxWidth: 1040, margin: '0 auto' }}>
      {/* Header */}
      <PageHeader
        breadcrumbs={[{ label: 'Workspace' }, { label: 'Drafts' }]}
        title="Drafts"
        description="Unfinished documents you've saved. Nothing here is in an approval workflow until you submit it."
        actions={
          <>
            <button onClick={() => navigate('/documents?compose=ai')} className="btn btn-secondary btn-sm" style={{ gap: 7 }}>
              <Sparkles size={14} /> Draft with AI
            </button>
            <button onClick={() => navigate('/documents?compose=1')} className="btn btn-primary btn-sm" style={{ gap: 7 }}>
              <Plus size={14} /> New document
            </button>
          </>
        }
      />
      <div style={{ height: 24 }} />

      {actionError && (
        <div
          style={{
            marginBottom: 16, padding: '10px 12px', borderRadius: 10,
            background: `color-mix(in srgb, ${C.danger} 8%, transparent)`,
            border: `1px solid color-mix(in srgb, ${C.danger} 25%, transparent)`,
            fontSize: 12.5, color: C.body, display: 'flex', gap: 7,
          }}
        >
          <AlertCircle size={14} color={C.danger} style={{ flexShrink: 0, marginTop: 1 }} />
          {actionError}
        </div>
      )}

      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} style={{ height: 68, borderRadius: 'var(--radius-lg)' }} />
          ))}
        </div>
      ) : isError ? (
        <div
          style={{
            background: `color-mix(in srgb, ${C.danger} 8%, transparent)`,
            border: `1px solid color-mix(in srgb, ${C.danger} 25%, transparent)`,
            borderRadius: 12, padding: 20, display: 'flex', gap: 9,
          }}
        >
          <AlertCircle size={16} color={C.danger} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: C.heading }}>
              Couldn't load your drafts
            </div>
            <div style={{ fontSize: 12.5, color: C.body, marginTop: 3 }}>
              {(error as Error)?.message || 'Please try again.'}
            </div>
          </div>
        </div>
      ) : drafts.length === 0 ? (
        <GlassCard style={{ padding: 8 }}>
          <EmptyState
            art="documents"
            title="No drafts yet"
            description="Documents you start but don't submit will appear here, so you can pick them up later."
            action={<button onClick={() => navigate('/documents?compose=1')} className="btn btn-primary btn-sm" style={{ gap: 7 }}><Plus size={14} /> Start a document</button>}
          />
        </GlassCard>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {drafts.map((d) => {
            const aiMeta = (d.metadata as Record<string, unknown> | undefined)?.[
              'ai_generation'
            ] as { placeholders?: string[]; model?: string } | undefined;
            const placeholders = aiMeta?.placeholders ?? [];
            return (
              <GlassCard
                key={d.id}
                variant="interactive"
                style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14 }}
              >
                <IconChip tone="primary" size={38}><FileText size={17} /></IconChip>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        fontSize: 14, fontWeight: 600, color: C.heading,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >
                      {d.title}
                    </span>
                    {aiMeta && (
                      <span
                        style={{
                          fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase',
                          letterSpacing: 0.5, color: C.primary400,
                          background: `color-mix(in srgb, ${C.primary400} 12%, transparent)`,
                          border: `1px solid color-mix(in srgb, ${C.primary400} 28%, transparent)`,
                          borderRadius: 20, padding: '1px 7px', flexShrink: 0,
                        }}
                      >
                        AI draft
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3 }}>
                    {[d.public_id, typeName(d.doc_type_id), `updated ${fmtWhen(d.updated_at)}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  {placeholders.length > 0 && (
                    <div
                      style={{
                        fontSize: 11.5, color: C.warning, marginTop: 5,
                        display: 'flex', alignItems: 'center', gap: 5,
                      }}
                    >
                      <Clock size={11} />
                      {placeholders.length} item{placeholders.length === 1 ? '' : 's'} still
                      need completing
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 7, flexShrink: 0 }}>
                  <button
                    onClick={() => navigate(`/documents/${d.id}`)}
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 12, gap: 6 }}
                  >
                    <FileEdit size={12} /> Continue
                  </button>
                  <button
                    onClick={() => navigate(`/documents/${d.id}?submit=1`)}
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 12, gap: 6, color: C.success }}
                    title="Review and submit for approval"
                  >
                    <Send size={12} /> Submit
                  </button>
                  <button
                    onClick={() => setConfirmId(d.id)}
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 12, gap: 6, color: C.danger }}
                  >
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmId}
        title="Delete draft"
        message="This draft will be deleted. This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => confirmId && deleteM.mutate(confirmId)}
        onCancel={() => setConfirmId(null)}
      />

      <style>{`
        .dspin { animation: dspin 0.9s linear infinite; }
        @keyframes dspin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
