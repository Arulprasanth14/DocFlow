/**
 * DocFlow — validity dates, reminder and watchers on the document detail page
 * (spec FR-13.4).
 *
 * Renders nothing when a document has none of these set, so an ordinary
 * document gains no empty card. Once a date or a watcher exists, this is
 * where it is visible and — while the document is still editable — editable.
 */
import { Calendar, BellRing, CheckCircle2 } from 'lucide-react';
import type { Document } from '@/types';
import { WatcherPicker } from '@/components/documents/WatcherPicker';

const EDITABLE = new Set(['draft', 'ready', 'sent_back']);

function fmt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

export function ValidityCard({ doc }: { doc: Document }) {
  const effective = fmt(doc.effective_from);
  const expires = fmt(doc.expires_at);
  const reminderDays = doc.reminder_days_before;
  const editable = EDITABLE.has(doc.status);
  const hasWatchers = (doc.watcher_count ?? 0) > 0;

  // Nothing set and nothing to add: show no card at all rather than an empty
  // one. A locked document with no dates and no watchers has nothing to say.
  if (!effective && !expires && !hasWatchers && !editable) return null;

  const expired = doc.expires_at ? new Date(doc.expires_at) < new Date() : false;

  return (
    <div className="glass-card" style={{ padding: 22, display: 'grid', gap: 18 }}>
      {(effective || expires) && (
        <section style={{ display: 'grid', gap: 10 }}>
          <header style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Calendar size={14} style={{ color: 'var(--muted-foreground)' }} aria-hidden="true" />
            <h3 style={{
              margin: 0, fontSize: '0.82rem', fontWeight: 700,
              color: 'var(--foreground)', textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              Validity
            </h3>
          </header>

          <dl style={{ margin: 0, display: 'grid', gap: 7 }}>
            {effective && (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <dt style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>Takes effect</dt>
                <dd style={{ margin: 0, fontSize: '0.82rem', fontWeight: 600, color: 'var(--foreground)' }}>
                  {effective}
                </dd>
              </div>
            )}
            {expires && (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <dt style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>Expires</dt>
                <dd style={{
                  margin: 0, fontSize: '0.82rem', fontWeight: 600,
                  color: expired ? 'var(--status-rejected-fg)' : 'var(--foreground)',
                }}>
                  {expires}{expired ? ' · passed' : ''}
                </dd>
              </div>
            )}
          </dl>

          {reminderDays != null && expires && (
            <p style={{
              display: 'flex', alignItems: 'center', gap: 7, margin: 0,
              padding: '7px 9px', borderRadius: 'var(--radius-sm)',
              background: 'var(--secondary)', fontSize: '0.76rem',
              color: 'var(--muted-foreground)',
            }}>
              {doc.reminder_sent_at ? (
                <>
                  <CheckCircle2 size={13} style={{ flexShrink: 0 }} aria-hidden="true" />
                  Expiry reminder sent {fmt(doc.reminder_sent_at)}.
                </>
              ) : (
                <>
                  <BellRing size={13} style={{ flexShrink: 0 }} aria-hidden="true" />
                  Reminder {reminderDays} day{reminderDays === 1 ? '' : 's'} before expiry.
                </>
              )}
            </p>
          )}
        </section>
      )}

      {/* The picker handles its own empty state and read-only mode. */}
      {(hasWatchers || editable) && <WatcherPicker docId={doc.id} disabled={!editable} />}
    </div>
  );
}

export default ValidityCard;
