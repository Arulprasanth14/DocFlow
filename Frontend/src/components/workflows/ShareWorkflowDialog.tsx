/**
 * DocFlow Frontend — Share a workflow (Workflow module §5.1, WF-OWN-02..11)
 *
 * Grants USE to one colleague and shows the owner's "Shared with" panel with
 * a Revoke action beside each recipient.
 *
 * Two rules shape this dialog:
 *  - WF-OWN-02: a share is only real once the BACKEND has recorded it, so
 *    success is shown after the 201 and never optimistically.
 *  - WF-OWN-07: sharing is idempotent. The response says whether a row was
 *    actually created, so re-sharing reports "already has access" rather than
 *    implying a second notification went out.
 *
 * The server is the authority on who may be shared with (same org, active,
 * not the owner); this picker just keeps the obvious cases out of the way.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Share2, Trash2, UserPlus, X } from 'lucide-react';

import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { ApiClientError } from '@/lib/api/client';
import {
  useRevokeWorkflowShare,
  useShareWorkflow,
  useWorkflowShares,
} from '@/hooks/useWorkflows';
import { useMembers } from '@/hooks/useOrg';

const C = {
  surface: 'var(--bg-surface)',
  card: 'var(--bg-elevated)',
  overlay: 'var(--bg-overlay)',
  border: 'var(--border-default)',
  borderSubtle: 'var(--border-subtle)',
  primary: 'var(--color-primary-400)',
  danger: 'var(--color-error-400)',
  heading: 'var(--text-primary)',
  body: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
};

export default function ShareWorkflowDialog({
  templateId,
  workflowName,
  ownerId,
  onClose,
}: {
  templateId: string;
  workflowName: string;
  /** Excluded from the picker: the owner already has it (WF-OWN-08). */
  ownerId: string | null;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState('');
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // UX-A11Y-03: Esc closes, and focus starts inside the dialog instead of
  // being left behind on the row that opened it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // useMembers returns a PaginatedResponse, so the rows live on .items.
  const { data: membersPage } = useMembers({ limit: 100 });
  const { data: shares = [], isLoading: sharesLoading } = useWorkflowShares(templateId);
  const shareM = useShareWorkflow(templateId);
  const revokeM = useRevokeWorkflowShare(templateId);

  const alreadyShared = useMemo(
    () => new Set(shares.map((s) => s.grantee_user_id)),
    [shares],
  );

  const options = useMemo(
    () =>
      (membersPage?.items ?? [])
        .filter(
          (m) =>
            m.user_id !== ownerId &&
            !alreadyShared.has(m.user_id) &&
            // The server refuses an inactive member anyway (WF-OWN-08); this
            // just keeps them out of the picker.
            m.status === 'active',
        )
        .map((m) => ({
          value: m.user_id,
          label: m.user?.name || m.user?.email || 'Unknown user',
          hint: m.user?.email,
        })),
    [membersPage, ownerId, alreadyShared],
  );

  async function onShare() {
    if (!selected) return;
    try {
      const result = await shareM.mutateAsync(selected);
      // WF-OWN-07: say what actually happened.
      if (result.created) {
        const who = result.share.grantee_name || result.share.grantee_email || 'They';
        toast.success(`${who} can now use this workflow`);
      } else {
        toast.info('They already had access to this workflow');
      }
      setSelected('');
    } catch (err) {
      // The server owns these rules, so show its message rather than guessing.
      const msg =
        err instanceof ApiClientError
          ? err.detail
          : err instanceof Error
            ? err.message
            : 'Could not share this workflow';
      toast.error(msg);
    }
  }

  async function onRevoke(userId: string, label: string) {
    try {
      await revokeM.mutateAsync(userId);
      toast.success(`Access removed for ${label}`);
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.detail : 'Could not remove access',
      );
    }
  }

  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--overlay-scrim)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-wf-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(540px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 18,
          padding: 22,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2
              id="share-wf-title"
              style={{
                margin: 0,
                fontSize: 17,
                fontWeight: 800,
                color: C.heading,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Share2 size={16} aria-hidden /> Share workflow
            </h2>
            <p
              style={{
                margin: '5px 0 0',
                fontSize: 12.5,
                color: C.muted,
                overflowWrap: 'anywhere',
              }}
            >
              {workflowName}
            </p>
          </div>
          <button
            type="button"
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            style={{
              background: C.overlay,
              border: `1px solid ${C.borderSubtle}`,
              borderRadius: 8,
              width: 30,
              height: 30,
              flexShrink: 0,
              cursor: 'pointer',
              color: C.muted,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <X size={15} aria-hidden />
          </button>
        </div>

        {/* The read-only explanation the spec dictates (§5.1 step 1). */}
        <p
          style={{
            margin: '16px 0 0',
            fontSize: 12.5,
            lineHeight: 1.55,
            color: C.body,
            background: C.overlay,
            border: `1px solid ${C.borderSubtle}`,
            borderRadius: 10,
            padding: '10px 12px',
          }}
        >
          They will be able to use this workflow for their documents. They cannot
          edit it.
        </p>

        <div style={{ marginTop: 16 }}>
          <label
            htmlFor="share-wf-user"
            style={{
              display: 'block',
              fontSize: 11.5,
              color: C.muted,
              marginBottom: 5,
            }}
          >
            Choose a colleague
          </label>
          <SearchableSelect
            id="share-wf-user"
            value={selected}
            onChange={setSelected}
            options={options}
            placeholder="Search people by name or email"
            emptyText="No one matches that search"
          />
          <button
            type="button"
            onClick={onShare}
            disabled={!selected || shareM.isPending}
            style={{
              marginTop: 11,
              width: '100%',
              minHeight: 44,
              borderRadius: 10,
              border: 'none',
              cursor: !selected || shareM.isPending ? 'not-allowed' : 'pointer',
              opacity: !selected || shareM.isPending ? 0.6 : 1,
              background: C.primary,
              color: 'var(--color-primary-foreground, #fff)',
              fontWeight: 700,
              fontSize: 13.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {shareM.isPending ? (
              <>
                <Loader2 size={14} className="wbspin" aria-hidden /> Sharing…
              </>
            ) : (
              <>
                <UserPlus size={14} aria-hidden /> Share
              </>
            )}
          </button>
        </div>

        {/* "Shared with" panel — WF-OWN-06 */}
        <div style={{ marginTop: 22 }}>
          <h3
            style={{
              margin: '0 0 9px',
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: 0.3,
              textTransform: 'uppercase',
              color: C.muted,
            }}
          >
            Shared with
          </h3>

          {sharesLoading ? (
            <p style={{ fontSize: 12.5, color: C.muted, margin: 0 }}>Loading…</p>
          ) : shares.length === 0 ? (
            <p style={{ fontSize: 12.5, color: C.muted, margin: 0 }}>
              Not shared with anyone yet. It stays private to you until you share it.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 7 }}>
              {shares.map((s) => {
                const label = s.grantee_name || s.grantee_email || 'Unknown user';
                return (
                  <li
                    key={s.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      background: C.card,
                      border: `1px solid ${C.borderSubtle}`,
                      borderRadius: 10,
                      padding: '9px 11px',
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 13,
                          color: C.heading,
                          fontWeight: 600,
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {label}
                      </span>
                      <span style={{ fontSize: 11.5, color: C.muted }}>
                        Can use this workflow
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => onRevoke(s.grantee_user_id, label)}
                      disabled={revokeM.isPending}
                      title="Remove access"
                      aria-label={`Remove access for ${label}`}
                      style={{
                        flexShrink: 0,
                        width: 44,
                        height: 44,
                        display: 'grid',
                        placeItems: 'center',
                        background: 'transparent',
                        border: `1px solid ${C.borderSubtle}`,
                        borderRadius: 9,
                        color: C.danger,
                        cursor: revokeM.isPending ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
