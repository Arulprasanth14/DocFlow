/**
 * DocFlow Frontend — Page: DocumentDetailPage (/documents/:id)
 * Comprehensive document workspace with dynamic form viewer/editor,
 * version audit trail modal, slide-over comment drawer, and file attachments manager.
 */

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  useDocument,
  useDocumentType,
  useUpdateDocument,
  useSubmitDocument,
  useDocumentAttachments,
  useAddDocumentAttachment,
  useRemoveDocumentAttachment,
  useDeleteDocument,
  useUploadFile,
  useSaveDocumentAsTemplate,
} from '@/hooks/useDocuments';
import { useAutosave } from '@/hooks/useAutosave';
import { SaveIndicator } from '@/components/ui/SaveIndicator';
import { ConflictDialog } from '@/components/ui/ConflictDialog';
import { useReviseAndResume, useCancelWorkflow } from '@/hooks/useWorkflows';
import documentsApi from '@/lib/api/documents';
import { useDepartments } from '@/hooks/useOrg';
import { useAuthStore } from '@/store/authStore';
import DynamicFormRenderer, { validateFormSchema } from '@/components/documents/DynamicFormRenderer';
import CommentDrawer from '@/components/documents/CommentDrawer';
import VersionHistoryModal from '@/components/documents/VersionHistoryModal';
import { SnapshotPdfCard } from '@/components/documents/SnapshotPdfCard';
import { ValidityCard } from '@/components/documents/ValidityCard';
import { ExportMenu } from '@/components/documents/ExportMenu';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { WorkflowChatPanel } from '@/components/ui/WorkflowChatPanel';
import SubmitWorkflowModal from '@/components/documents/SubmitWorkflowModal';

// NOTE: must match Backend/app/models/document.py::DocumentStatus exactly
// (draft, submitted, pending, approved, rejected, sent_back, archived, expired).
function getStatusBadge(status: string) {
  switch (status) {
    case 'approved':
      return { label: 'Approved', bg: 'var(--status-approved-bg)', color: 'var(--status-approved)' };
    case 'pending':
      return { label: 'Pending Approval', bg: 'var(--status-pending-bg)', color: 'var(--status-pending)' };
    case 'sent_back':
      return { label: 'Sent Back', bg: 'var(--status-pending-bg)', color: 'var(--status-pending)' };
    case 'submitted':
      return { label: 'Submitted', bg: 'var(--status-review-bg)', color: 'var(--status-review)' };
    case 'rejected':
      return { label: 'Rejected', bg: 'var(--status-rejected-bg)', color: 'var(--status-rejected)' };
    case 'archived':
      return { label: 'Archived', bg: 'var(--status-draft-bg)', color: 'var(--status-draft)' };
    case 'expired':
      return { label: 'Expired', bg: 'var(--status-draft-bg)', color: 'var(--status-draft)' };
    case 'cancelled':
      return { label: 'Cancelled', bg: 'var(--status-draft-bg)', color: 'var(--status-draft)' };
    case 'draft':
    default:
      return { label: 'Draft', bg: 'var(--status-draft-bg)', color: 'var(--status-draft)' };
  }
}

export default function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  // Queries
  const { data: doc, isLoading: docLoading } = useDocument(id || '');
  const { data: docType } = useDocumentType(doc?.doc_type_id || '');
  const { data: departments = [] } = useDepartments(true);
  const { data: attachments = [] } = useDocumentAttachments(id || '');

  // Mutations
  const updateDoc = useUpdateDocument();
  const submitDoc = useSubmitDocument();
  const addAtt = useAddDocumentAttachment();
  const removeAtt = useRemoveDocumentAttachment();
  const deleteDoc = useDeleteDocument();
  const uploadFile = useUploadFile();
  const reviseAndResume = useReviseAndResume();
  const cancelWorkflow = useCancelWorkflow();
  const saveAsTemplate = useSaveDocumentAsTemplate();
  const currentUserId = useAuthStore((s) => s.user?.id);

  // UI state
  const [isEditing, setIsEditing] = useState(false);
  const [savedAsTemplate, setSavedAsTemplate] = useState<{ id: string; name: string } | null>(null);
  const [templateError, setTemplateError] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editPriority, setEditPriority] = useState('normal');
  const [editDeptId, setEditDeptId] = useState('');
  const [editDueAt, setEditDueAt] = useState('');
  const [editFormData, setEditFormData] = useState<Record<string, unknown>>({});
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState('');

  // Modals / Drawers state
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [workflowChatOpen, setWorkflowChatOpen] = useState(false);
  const [submitModalOpen, setSubmitModalOpen] = useState(false);

  // New Attachment state
  const [newAttFile, setNewAttFile] = useState<File | null>(null);
  const [newAttLabel, setNewAttLabel] = useState('');
  const [attAdding, setAttAdding] = useState(false);
  const [attError, setAttError] = useState('');

  /**
   * Autosave while editing a DRAFT (spec FR-14.1: "no manual save is required").
   *
   * Deliberately scoped to drafts: on a `sent_back` document the Save button
   * also runs revise-and-resume, which pushes the workflow forward. Autosaving
   * that would resubmit the document on every keystroke, so that path keeps its
   * explicit "Save & Resubmit".
   */
  const draftEditing = isEditing && doc?.status === 'draft';
  const autosave = useAutosave({
    docId: id || '',
    initialVersion: doc?.version ?? 1,
    enabled: !!draftEditing,
  });

  const [confirmState, setConfirmState] = useState<{ open: boolean; title: string; message: string; confirmLabel: string; onConfirm: () => void }>({
    open: false, title: '', message: '', confirmLabel: 'Confirm', onConfirm: () => {}
  });

  // Arrived here straight from "Continue to Submit →" on the create page —
  // open the review-and-submit modal immediately instead of making the user
  // find the button again. Clear the state so a later back/refresh doesn't
  // reopen it.
  useEffect(() => {
    if ((location.state as { openSubmit?: boolean } | null)?.openSubmit && doc?.status === 'draft') {
      setSubmitModalOpen(true);
      navigate(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.status]);

  if (docLoading) {
    return (
      <div style={{ padding: '64px', textAlign: 'center' }}>
        <div className="spinner" style={{ width: '36px', height: '36px', margin: '0 auto' }} />
      </div>
    );
  }

  if (!doc) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', maxWidth: '600px', margin: '0 auto' }}>
        <div className="glass-card" style={{ padding: '40px' }}>
          <h2 style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '10px' }}>
            Document Not Found
          </h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: '20px' }}>
            The requested document may have been deleted or you lack access.
          </p>
          <button onClick={() => navigate('/documents')} className="btn btn-secondary">
            ← Back to Repository
          </button>
        </div>
      </div>
    );
  }

  const statusInfo = getStatusBadge(doc.status);
  const dept = departments.find((d) => d.id === doc.dept_id);

  const startEdit = () => {
    setEditTitle(doc.title);
    setEditPriority(doc.priority);
    setEditDeptId(doc.dept_id || '');
    setEditDueAt(doc.due_at ? doc.due_at.slice(0, 10) : '');
    setEditFormData({ ...doc.form_data });
    setFormErrors({});
    setGeneralError('');
    autosave.setVersion(doc.version ?? 1);
    setIsEditing(true);
  };

  /** Queue a draft change for autosave; a no-op outside draft editing. */
  const queueDraft = (patch: Parameters<typeof autosave.queueChange>[0]) => {
    if (doc.status === 'draft') autosave.queueChange(patch);
  };

  const finishDraftEditing = async () => {
    await autosave.flush();
    setIsEditing(false);
  };

  const handleSaveAsTemplate = async () => {
    setTemplateError('');
    setSavedAsTemplate(null);
    try {
      const created = await saveAsTemplate.mutateAsync({ docId: doc.id, data: { name: doc.title } });
      setSavedAsTemplate(created);
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : 'Could not save this as a template.');
    }
  };

  const handleSave = async () => {
    setGeneralError('');
    if (!editTitle.trim()) {
      setGeneralError('Title is required.');
      return;
    }

    if (docType?.form_schema) {
      const validation = validateFormSchema(docType.form_schema, editFormData);
      if (!validation.isValid) {
        setFormErrors(validation.errors);
        setGeneralError('Please fix the highlighted errors in custom fields.');
        return;
      }
    }

    const wasSentBack = doc.status === 'sent_back';

    try {
      await updateDoc.mutateAsync({
        id: doc.id,
        data: {
          title: editTitle.trim(),
          priority: editPriority,
          dept_id: editDeptId || null,
          due_at: editDueAt ? new Date(editDueAt).toISOString() : null,
          form_data: editFormData,
          change_reason: wasSentBack ? 'Revised after changes requested' : 'Updated document details',
        },
      });

      // If the approver sent this back for changes, saving the edit also
      // resumes the workflow at the same stage (revise-and-resume) instead of
      // leaving the document stuck in 'sent_back' with no way forward.
      if (wasSentBack) {
        const versions = await documentsApi.listVersions(doc.id);
        const latest = versions[0];
        if (latest) {
          await reviseAndResume.mutateAsync({
            documentId: doc.id,
            payload: { new_version_id: latest.id, note: 'Revised and resubmitted' },
          });
        }
      }

      setIsEditing(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update document';
      setGeneralError(msg);
    }
  };

  const handleOpenSubmitModal = () => {
    setSubmitModalOpen(true);
  };

  const handleConfirmSubmit = async ({ workflowTemplateId, dueAt }: { workflowTemplateId: string; dueAt: string | null }) => {
    // submitDoc.isPending (checked by the modal's isSubmitting prop) already
    // guards against a double-click re-firing this while the first request
    // is in flight; the backend's own status check (only DRAFT documents
    // can be submitted) is the second line of defense.
    if (dueAt !== (doc.due_at || null)) {
      await updateDoc.mutateAsync({ id: doc.id, data: { due_at: dueAt } });
    }
    await submitDoc.mutateAsync({
      id: doc.id,
      payload: { change_reason: 'Submitted for approval', workflow_template_id: workflowTemplateId },
    });
    setSubmitModalOpen(false);
  };

  const handleCancelWorkflow = async () => {
    if (!doc.current_workflow_instance_id) return;
    const instanceId = doc.current_workflow_instance_id;
    setConfirmState({
      open: true,
      title: 'Cancel Workflow',
      message: 'This withdraws the document from approval. This cannot be undone — you\'ll need to resubmit from scratch.',
      confirmLabel: 'Cancel Workflow',
      onConfirm: async () => {
        setConfirmState(prev => ({ ...prev, open: false }));
        try {
          await cancelWorkflow.mutateAsync({ instanceId, payload: { reason: 'Cancelled by submitter' } });
        } catch {
          // Error surfaced via cancelWorkflow.error in the UI if needed
        }
      }
    });
  };

  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // matches Backend/app/core/storage.py MAX_FILE_SIZE_BYTES
  const ALLOWED_MIME_TYPES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg',
    'image/png',
    'image/tiff',
    'image/webp',
    'text/plain',
    'text/csv',
  ]);

  const handleFileSelected = (file: File | null) => {
    setAttError('');
    if (!file) {
      setNewAttFile(null);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setAttError(`File is too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
      setNewAttFile(null);
      return;
    }
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      setAttError(`File type "${file.type || 'unknown'}" is not allowed`);
      setNewAttFile(null);
      return;
    }
    setNewAttFile(file);
  };

  const handleAddAttachment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAttFile) return;

    try {
      setAttAdding(true);
      setAttError('');
      const fileAssetId = await uploadFile.mutateAsync(newAttFile);
      await addAtt.mutateAsync({
        docId: doc.id,
        data: {
          file_asset_id: fileAssetId,
          label: newAttLabel.trim() || undefined,
        },
      });
      setNewAttFile(null);
      setNewAttLabel('');
    } catch (err) {
      setAttError(err instanceof Error ? err.message : 'Failed to upload file');
    } finally {
      setAttAdding(false);
    }
  };

  /** FR-14.9 — discard a draft the author no longer wants. */
  const handleDiscardDraft = () => {
    setConfirmState({
      open: true,
      title: 'Discard this draft?',
      message:
        'It will be removed from your documents. Nothing is sent to anyone, '
        + 'and an administrator can still recover it if this was a mistake.',
      confirmLabel: 'Discard draft',
      onConfirm: async () => {
        setConfirmState((prev) => ({ ...prev, open: false }));
        await deleteDoc.mutateAsync(doc.id);
        navigate('/documents');
      },
    });
  };

  const handleRemoveAtt = async (attId: string) => {
    setConfirmState({
      open: true,
      title: 'Remove Attachment',
      message: 'Are you sure you want to remove this attachment?',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        setConfirmState(prev => ({ ...prev, open: false }));
        await removeAtt.mutateAsync({ docId: doc.id, attId });
      }
    });
  };

  return (
    <div style={{ padding: '32px', maxWidth: '1280px', margin: '0 auto' }}>
      {/* Top Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '24px',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        <div>
          <button
            onClick={() => navigate('/documents')}
            className="btn btn-ghost btn-sm"
            style={{ marginBottom: '10px', paddingLeft: 0, color: 'var(--text-secondary)' }}
          >
            ← Back to Repository
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: 'monospace',
                fontWeight: 700,
                fontSize: '0.85rem',
                color: 'var(--color-primary-400)',
                background: 'color-mix(in srgb, var(--primary) 10%, transparent)',
                padding: '4px 10px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {doc.public_id}
            </span>
            <span
              style={{
                fontSize: '0.78rem',
                fontWeight: 700,
                color: statusInfo.color,
                background: statusInfo.bg,
                padding: '4px 12px',
                borderRadius: 'var(--radius-full)',
              }}
            >
              {statusInfo.label}
            </span>
            <span
              style={{
                fontSize: '0.78rem',
                fontWeight: 600,
                color: 'var(--text-secondary)',
                background: 'var(--bg-overlay)',
                padding: '4px 10px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {doc.doc_type_name || 'Document'}
            </span>
          </div>

          <h1
            data-page-title
            className="font-display"
            style={{
              fontSize: 'clamp(1.6rem, 1.2rem + 1.5vw, 2.1rem)',
              fontWeight: 400,
              lineHeight: 1.15,
              color: 'var(--foreground)',
              marginTop: '8px',
              outline: 'none',
            }}
          >
            {isEditing ? (
              <input
                type="text"
                className="input"
                value={editTitle}
                onChange={(e) => { setEditTitle(e.target.value); queueDraft({ title: e.target.value }); }}
                style={{ fontSize: '1.5rem', fontWeight: 800, maxWidth: '520px' }}
              />
            ) : (
              doc.title
            )}
          </h1>
        </div>

        {/* Top Right Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <button
            onClick={() => setHistoryOpen(true)}
            className="btn btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <span>⏱️</span>
            <span>Version History ({doc.version_count || 1})</span>
          </button>

          <button
            onClick={() => setCommentsOpen(true)}
            className="btn btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <span>💬</span>
            <span>Comments ({doc.comment_count || 0})</span>
          </button>

          {doc.current_approval_step_id && (
            <button
              onClick={() => setWorkflowChatOpen(true)}
              className="btn btn-secondary"
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <span>🗨️</span>
              <span>{doc.status === 'sent_back' ? 'Discuss Changes Requested' : 'Approver Discussion'}</span>
            </button>
          )}

          {isEditing ? (
            <>
              {/* A draft saves itself, so the only thing left to do is finish. */}
              {draftEditing ? (
                <>
                  <SaveIndicator
                    state={autosave.state}
                    lastSavedAt={autosave.lastSavedAt}
                    onRetry={() => autosave.flush()}
                  />
                  <button onClick={finishDraftEditing} className="btn btn-primary">
                    Done
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setIsEditing(false)}
                    className="btn btn-ghost"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    className="btn btn-primary"
                    disabled={updateDoc.isPending || reviseAndResume.isPending}
                  >
                    {updateDoc.isPending || reviseAndResume.isPending
                      ? (doc.status === 'sent_back' ? 'Resubmitting...' : 'Saving...')
                      : (doc.status === 'sent_back' ? 'Save & Resubmit →' : 'Save Changes')}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                onClick={startEdit}
                className="btn btn-secondary"
              >
                {doc.status === 'sent_back' ? 'Revise Document' : 'Edit Document'}
              </button>

              {/* FR-6.7 — download as PDF or Word. */}
              {id && <ExportMenu docId={id} />}

              {/* FR-5.4 — turn a document you use often into a template. */}
              <button
                onClick={handleSaveAsTemplate}
                className="btn btn-ghost"
                disabled={saveAsTemplate.isPending}
                title="Create a private, editable template from this document"
              >
                {saveAsTemplate.isPending ? 'Saving…' : 'Save as template'}
              </button>

              {/* FR-14.9 — "Explicit Discard draft is always available".
                  Soft delete, so it can be recovered from the database if
                  someone discards the wrong thing. */}
              {doc.status === 'draft' && (
                <button
                  onClick={handleDiscardDraft}
                  className="btn btn-ghost"
                  disabled={deleteDoc.isPending}
                  title="Delete this draft"
                  style={{ color: 'var(--color-error-400)' }}
                >
                  {deleteDoc.isPending ? 'Discarding…' : 'Discard draft'}
                </button>
              )}

              {doc.status === 'draft' && (
                <button
                  onClick={handleOpenSubmitModal}
                  className="btn btn-primary"
                  disabled={submitDoc.isPending}
                  style={{ background: 'var(--color-primary-600)' }}
                >
                  Submit for Approval →
                </button>
              )}

              {doc.current_workflow_instance_id &&
                ['pending', 'sent_back'].includes(doc.status) &&
                doc.submitted_by === currentUserId && (
                <button
                  onClick={handleCancelWorkflow}
                  className="btn btn-ghost"
                  disabled={cancelWorkflow.isPending}
                  style={{ color: 'var(--color-error-400)' }}
                >
                  {cancelWorkflow.isPending ? 'Cancelling...' : 'Cancel Workflow'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {savedAsTemplate && (
        <div role="status" style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', marginBottom: '20px',
          borderRadius: 'var(--radius)', background: 'var(--status-approved-bg)',
          border: '1px solid color-mix(in srgb, var(--status-approved) 30%, transparent)',
          color: 'var(--status-approved)', fontSize: '0.86rem', fontWeight: 600,
        }}>
          <span>Saved as the template &ldquo;{savedAsTemplate.name}&rdquo;. Mark its blanks to make it fillable.</span>
          <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }}
            onClick={() => navigate(`/documents/templates/${savedAsTemplate.id}/edit`)}>
            Open template
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setSavedAsTemplate(null)}>Dismiss</button>
        </div>
      )}
      {templateError && (
        <div role="alert" style={{
          padding: '12px 16px', marginBottom: '20px', borderRadius: 'var(--radius)',
          background: 'var(--status-rejected-bg)', color: 'var(--status-rejected)',
          fontSize: '0.86rem', fontWeight: 600,
        }}>{templateError}</div>
      )}

      {generalError && (
        <div
          style={{
            padding: '14px 18px',
            background: 'color-mix(in srgb, var(--destructive) 12%, transparent)',
            border: '1px solid var(--color-error-400)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--color-error-400)',
            fontSize: '0.88rem',
            fontWeight: 600,
            marginBottom: '20px',
          }}
        >
          ⚠️ {generalError}
        </div>
      )}

      {/* Grid Layout: Main Content (left) + Metadata & Attachments Sidebar (right) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '28px' }}>
        {/* Left Main Content */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Custom Form Card */}
          <div className="glass-card" style={{ padding: '28px' }}>
            <h2
              style={{
                fontSize: '1.15rem',
                fontWeight: 800,
                color: 'var(--text-primary)',
                marginBottom: '20px',
                paddingBottom: '12px',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              Document Form Fields ({doc.doc_type_name})
            </h2>

            <DynamicFormRenderer
              schema={docType?.form_schema || []}
              values={isEditing ? editFormData : doc.form_data || {}}
              onChange={(key, val) => {
                if (isEditing) {
                  setEditFormData((prev) => {
                    const next = { ...prev, [key]: val };
                    // Drafts accept partial/invalid data; validation runs on
                    // submit, not while typing (FR-14.4).
                    queueDraft({ form_data: next });
                    return next;
                  });
                }
              }}
              errors={formErrors}
              disabled={!isEditing}
            />
          </div>
        </div>

        {/* Right Sidebar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Document Properties Card */}
          <div className="glass-card" style={{ padding: '22px' }}>
            <h3
              style={{
                fontSize: '0.95rem',
                fontWeight: 700,
                color: 'var(--text-primary)',
                marginBottom: '16px',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              Document Properties
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '0.88rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Priority</span>
                {isEditing ? (
                  <select
                    className="input"
                    value={editPriority}
                    onChange={(e) => { setEditPriority(e.target.value); queueDraft({ priority: e.target.value }); }}
                    style={{ width: '130px', padding: '4px 8px', fontSize: '0.8rem' }}
                  >
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                    <option value="low">Low</option>
                  </select>
                ) : (
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)', textTransform: 'capitalize' }}>
                    {doc.priority}
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Department</span>
                {isEditing ? (
                  <select
                    className="input"
                    value={editDeptId}
                    onChange={(e) => { setEditDeptId(e.target.value); queueDraft({ dept_id: e.target.value || null }); }}
                    style={{ width: '150px', padding: '4px 8px', fontSize: '0.8rem' }}
                  >
                    <option value="">Unassigned</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {dept ? dept.name : 'Unassigned'}
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Target Due</span>
                {isEditing ? (
                  <input
                    type="date"
                    className="input"
                    value={editDueAt}
                    onChange={(e) => { setEditDueAt(e.target.value); queueDraft({ due_at: e.target.value ? new Date(e.target.value).toISOString() : null }); }}
                    style={{ width: '140px', padding: '4px 8px', fontSize: '0.8rem' }}
                  />
                ) : (
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {doc.due_at ? new Date(doc.due_at).toLocaleDateString() : 'No deadline'}
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Submitted By</span>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                  {doc.submitter_name || 'Member'}
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Submitted At</span>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                  {doc.submitted_at
                    ? new Date(doc.submitted_at).toLocaleDateString()
                    : 'Not submitted'}
                </span>
              </div>
            </div>
          </div>

          {/* FR-13.8 — the frozen submission as a PDF. Renders nothing for a
              draft, so a document that was never submitted shows no card. */}
          {id && <SnapshotPdfCard docId={id} />}

          {/* FR-13.4 — validity dates, expiry reminder and watchers. Also
              renders nothing when there is none of that to show. */}
          <ValidityCard doc={doc} />

          {/* Attachments Card */}
          <div className="glass-card" style={{ padding: '22px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '16px',
              }}
            >
              <h3
                style={{
                  fontSize: '0.95rem',
                  fontWeight: 700,
                  color: 'var(--text-primary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                Attachments ({attachments.length})
              </h3>
            </div>

            {/* List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '16px' }}>
              {attachments.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem', textAlign: 'center', padding: '16px' }}>
                  No files attached to this document.
                </div>
              ) : (
                attachments.map((att) => (
                  <div
                    key={att.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 12px',
                      background: 'var(--bg-overlay)',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '1.1rem' }}>📎</span>
                      <div>
                        <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {att.label || att.filename || 'Attached File'}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                          {att.mime_type || 'File asset'} — {att.size_bytes ? `${Math.round(att.size_bytes / 1024)} KB` : 'Linked asset'}
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() => handleRemoveAtt(att.id)}
                      className="btn btn-ghost btn-sm"
                      title="Remove Attachment"
                      style={{ color: 'var(--color-error-400)', padding: '4px' }}
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Add Attachment Inline Form */}
            <form
              onSubmit={handleAddAttachment}
              style={{
                paddingTop: '14px',
                borderTop: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              {/* Styled file picker — the raw browser input ("Choose File / No
                  file chosen") ignores the design system, so the real input is
                  visually hidden inside this label. */}
              <label
                // The visible text inside this label is conditional, so its
                // accessible name is pinned here instead of depending on
                // whichever state the picker happens to be in.
                aria-label="Choose a file to attach"
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: newAttFile ? '10px 12px' : '16px 12px',
                  borderRadius: 'var(--radius)',
                  border: `1px ${newAttFile ? 'solid' : 'dashed'} ${newAttFile ? 'var(--border)' : 'var(--border)'}`,
                  background: newAttFile ? 'var(--card)' : 'transparent',
                  cursor: attAdding ? 'not-allowed' : 'pointer',
                  opacity: attAdding ? 0.6 : 1,
                  transition: 'background 0.15s, border-color 0.15s',
                }}
              >
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.tiff,.webp,.txt,.csv"
                  onChange={(e) => handleFileSelected(e.target.files?.[0] ?? null)}
                  disabled={attAdding}
                  style={{
                    position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
                    overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
                  }}
                />
                <span
                  aria-hidden="true"
                  style={{
                    width: 32, height: 32, flexShrink: 0, borderRadius: 'var(--radius-sm)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'color-mix(in srgb, var(--primary) 10%, transparent)',
                    color: 'var(--primary)',
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{
                    display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {newAttFile ? newAttFile.name : 'Choose a file to attach'}
                  </span>
                  <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 1 }}>
                    {newAttFile
                      ? `${(newAttFile.size / 1024 / 1024).toFixed(2)} MB — click to change`
                      : 'PDF, Word, Excel, image or text'}
                  </span>
                </span>
              </label>
              <input
                type="text"
                className="input"
                placeholder="Label (e.g. Signed contract PDF)..."
                value={newAttLabel}
                onChange={(e) => setNewAttLabel(e.target.value)}
                style={{ fontSize: '0.8rem' }}
                disabled={attAdding}
              />
              {attError && (
                <div style={{ color: 'var(--color-error-400)', fontSize: '0.75rem' }}>
                  {attError}
                </div>
              )}
              <button
                type="submit"
                disabled={!newAttFile || attAdding}
                className="btn btn-secondary btn-sm"
                style={{ width: '100%' }}
              >
                {attAdding
                  ? (uploadFile.isPending ? 'Uploading...' : 'Attaching...')
                  : '+ Upload & Attach File'}
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Two tabs editing the same draft (§24.3 / FR-14.6) */}
      <ConflictDialog
        open={autosave.conflict}
        onKeepMine={async () => {
          autosave.queueChange({
            title: editTitle.trim() || doc.title,
            priority: editPriority,
            dept_id: editDeptId || null,
            due_at: editDueAt ? new Date(editDueAt).toISOString() : null,
            form_data: editFormData,
          });
          await autosave.flush();
        }}
        onLoadLatest={() => { autosave.reset(); setIsEditing(false); }}
      />

      {/* Slide-over Comments Drawer */}
      <CommentDrawer
        isOpen={commentsOpen}
        onClose={() => setCommentsOpen(false)}
        docId={doc.id}
        docTitle={doc.title}
      />

      {/* Audit Trail / Version History Modal */}
      <VersionHistoryModal
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
        docId={doc.id}
        docTitle={doc.title}
        currentVersionNum={doc.version_count || 1}
      />

      {/* Workflow Chat — discussion pinned to the current/most recent approval step */}
      {doc.current_approval_step_id && (
        <WorkflowChatPanel
          approvalStepId={doc.current_approval_step_id}
          contextLabel={`${doc.title} — ${doc.doc_type_name || 'Document'}`}
          isOpen={workflowChatOpen}
          onClose={() => setWorkflowChatOpen(false)}
        />
      )}

      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        onConfirm={confirmState.onConfirm}
        onCancel={() => setConfirmState(prev => ({ ...prev, open: false }))}
      />

      <SubmitWorkflowModal
        open={submitModalOpen}
        documentTitle={doc.title}
        initialDueAt={doc.due_at}
        onCancel={() => setSubmitModalOpen(false)}
        onConfirm={handleConfirmSubmit}
        isSubmitting={updateDoc.isPending || submitDoc.isPending}
      />
    </div>
  );
}
