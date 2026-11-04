/**
 * DocFlow — My Templates (/documents/templates/mine)
 * Spec §8.5 FR-5.3/5.5, screen 9: manage private templates — edit (new version),
 * duplicate, delete (soft) — with a quota meter and the full set of
 * loading / empty / error states.
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Plus, Copy, Trash2, PenLine, RotateCw, FileText, Star, Archive, ArchiveRestore } from 'lucide-react';
import {
  useTemplates, useDuplicateTemplate, useDeleteTemplate,
  useToggleTemplateFavourite, useArchiveTemplate,
} from '@/hooks/useTemplates';
import type { TemplateSummary } from '@/lib/api/templates';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

const QUOTA = 50; // mirrors TEMPLATE_QUOTA_PER_USER (spec §30)

export default function MyTemplatesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [showArchived, setShowArchived] = useState(false);
  const { data: templates = [], isLoading, isError, refetch } = useTemplates({
    scope: 'user', include_archived: showArchived,
  });
  const duplicate = useDuplicateTemplate();
  const remove = useDeleteTemplate();
  const toggleFavourite = useToggleTemplateFavourite();
  const archive = useArchiveTemplate();

  const [confirm, setConfirm] = useState<TemplateSummary | null>(null);
  const [actionError, setActionError] = useState('');

  // Archived templates don't count against the quota (the server frees the slot).
  const activeCount = templates.filter((t) => t.status !== 'archived').length;

  // Highlight a template just published (FR-11.4).
  const publishedId = (location.state as { published?: string } | null)?.published;
  const [highlight, setHighlight] = useState<string | undefined>(publishedId);
  useEffect(() => {
    if (!publishedId) return;
    const t = setTimeout(() => setHighlight(undefined), 2000);
    navigate(location.pathname, { replace: true, state: null });
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishedId]);

  const atQuota = activeCount >= QUOTA;

  const handleDuplicate = async (t: TemplateSummary) => {
    setActionError('');
    try { await duplicate.mutateAsync(t.id); }
    catch (err) { setActionError(err instanceof Error ? err.message : 'Could not duplicate.'); }
  };

  const handleArchive = async (t: TemplateSummary) => {
    setActionError('');
    try { await archive.mutateAsync({ id: t.id, archived: t.status !== 'archived' }); }
    catch (err) { setActionError(err instanceof Error ? err.message : 'Could not change the archive state.'); }
  };

  const handleFavourite = async (t: TemplateSummary) => {
    setActionError('');
    try { await toggleFavourite.mutateAsync({ id: t.id, on: !t.is_favourite }); }
    catch (err) { setActionError(err instanceof Error ? err.message : 'Could not update your favourites.'); }
  };

  const handleDelete = async () => {
    if (!confirm) return;
    const target = confirm;
    setConfirm(null);
    setActionError('');
    try { await remove.mutateAsync(target.id); }
    catch (err) { setActionError(err instanceof Error ? err.message : 'Could not delete.'); }
  };

  return (
    <div className="page-content" style={{ paddingTop: 24, maxWidth: 1100, margin: '0 auto' }}>
      <PageHeader
        breadcrumbs={[{ label: 'Documents' }, { label: 'My templates' }]}
        title="My templates"
        description="Private templates only you can see. Editing a published template creates a new version."
        actions={
          <button className="btn btn-primary" disabled={atQuota}
            title={atQuota ? `You've reached the limit of ${QUOTA} templates.` : undefined}
            onClick={() => navigate('/documents/templates/new')}>
            <Plus size={16} /> Create template
          </button>
        }
      />
      <div style={{ height: 16 }} />

      {/* Quota meter (FR-5.5) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <div style={{ flex: '0 0 180px', height: 6, borderRadius: 999, background: 'var(--muted)', overflow: 'hidden' }}>
          <div style={{
            width: `${Math.min(100, (activeCount / QUOTA) * 100)}%`, height: '100%',
            background: atQuota ? 'var(--status-rejected)' : 'var(--primary)',
          }} />
        </div>
        <span style={{ fontSize: '0.8rem', color: atQuota ? 'var(--status-rejected)' : 'var(--muted-foreground)' }}>
          {activeCount} of {QUOTA} templates{atQuota ? ' — archive one to create another.' : ''}
        </span>
        <label style={{
          marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7,
          fontSize: '0.8rem', color: 'var(--muted-foreground)', cursor: 'pointer',
        }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      {actionError && (
        <div role="alert" style={{
          padding: '12px 16px', marginBottom: 16, borderRadius: 'var(--radius)',
          background: 'var(--status-rejected-bg)', color: 'var(--status-rejected)', fontSize: '0.85rem', fontWeight: 600,
        }}>{actionError}</div>
      )}

      {isLoading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 150, borderRadius: 'var(--radius-lg)' }} />
          ))}
        </div>
      ) : isError ? (
        <EmptyState art="search" title="Couldn't load your templates"
          description="Something went wrong fetching this list."
          action={<button className="btn btn-primary" onClick={() => refetch()}><RotateCw size={15} /> Retry</button>} />
      ) : templates.length === 0 ? (
        <EmptyState art="documents" title="You have no templates yet"
          description="Turn a document you use often into a template."
          action={<button className="btn btn-primary" onClick={() => navigate('/documents/templates/new')}><Plus size={15} /> Create your first</button>} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {templates.map((t) => (
            <motion.div key={t.id}
              animate={highlight === t.id ? { boxShadow: '0 0 0 2px var(--primary)' } : { boxShadow: '0 0 0 0 transparent' }}
              transition={{ duration: 0.3 }}
              style={{
                display: 'flex', flexDirection: 'column', gap: 8, padding: 18,
                borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', background: 'var(--card)',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{
                  fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
                  padding: '3px 8px', borderRadius: 999,
                  background: t.status === 'published' ? 'var(--status-approved-bg)' : 'var(--status-draft-bg)',
                  color: t.status === 'published' ? 'var(--status-approved)' : 'var(--status-draft)',
                }}>{t.status}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
                  {t.version_no != null && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)' }}>v{t.version_no}</span>
                  )}
                  <button
                    onClick={() => handleFavourite(t)} title="Favourite"
                    aria-label={`${t.is_favourite ? 'Unfavourite' : 'Favourite'} ${t.name}`}
                    style={{
                      display: 'inline-flex', background: 'transparent', border: 'none', padding: 2, cursor: 'pointer',
                      color: t.is_favourite ? 'var(--accent-amber)' : 'var(--muted-foreground)',
                    }}>
                    <Star size={15} fill={t.is_favourite ? 'var(--accent-amber)' : 'none'} />
                  </button>
                </div>
              </div>

              <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--foreground)', margin: 0 }}>{t.name}</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)', margin: 0, flex: 1 }}>
                {t.description || 'No description.'}
              </p>

              <div style={{ display: 'flex', gap: 12, fontSize: '0.75rem', color: 'var(--muted-foreground)', fontWeight: 600 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <FileText size={12} /> {t.field_count} question{t.field_count === 1 ? '' : 's'}
                </span>
                <span>{t.usage_count} use{t.usage_count === 1 ? '' : 's'}</span>
              </div>

              <div style={{ display: 'flex', gap: 6, marginTop: 8, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/documents/templates/${t.id}/edit`)}>
                  <PenLine size={13} /> Edit
                </button>
                <button className="btn btn-ghost btn-sm" disabled={duplicate.isPending || atQuota}
                  title={atQuota ? 'Template limit reached' : 'Duplicate'}
                  aria-label={`Duplicate ${t.name}`}
                  onClick={() => handleDuplicate(t)}><Copy size={13} /></button>
                <button className="btn btn-ghost btn-sm" disabled={archive.isPending}
                  title={t.status === 'archived' ? 'Restore' : 'Archive'}
                  aria-label={`${t.status === 'archived' ? 'Restore' : 'Archive'} ${t.name}`}
                  onClick={() => handleArchive(t)}>
                  {t.status === 'archived' ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                </button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--status-rejected)', marginLeft: 'auto' }}
                  title="Delete" aria-label={`Delete ${t.name}`}
                  onClick={() => setConfirm(t)}><Trash2 size={13} /></button>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title="Delete template"
        message={`Delete "${confirm?.name}"? Documents already created from it keep their copy.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setConfirm(null)}
      />
      <div style={{ height: 32 }} />
    </div>
  );
}
