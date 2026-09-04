/**
 * DocFlow Frontend — Page: DocumentDetailPage (/documents/:id)
 * Comprehensive document workspace with dynamic form viewer/editor,
 * version audit trail modal, slide-over comment drawer, and file attachments manager.
 */

import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  useDocument,
  useDocumentType,
  useUpdateDocument,
  useSubmitDocument,
  useDocumentAttachments,
  useAddDocumentAttachment,
  useRemoveDocumentAttachment,
} from '@/hooks/useDocuments';
import { useDepartments } from '@/hooks/useOrg';
import DynamicFormRenderer, { validateFormSchema } from '@/components/documents/DynamicFormRenderer';
import CommentDrawer from '@/components/documents/CommentDrawer';
import VersionHistoryModal from '@/components/documents/VersionHistoryModal';

function getStatusBadge(status: string) {
  switch (status) {
    case 'approved':
      return { label: 'Approved', bg: 'hsla(150, 80%, 40%, 0.15)', color: 'var(--color-success-400)' };
    case 'in_review':
      return { label: 'In Review', bg: 'hsla(217, 100%, 50%, 0.15)', color: 'var(--color-primary-300)' };
    case 'submitted':
      return { label: 'Submitted', bg: 'hsla(260, 90%, 65%, 0.15)', color: 'var(--color-accent-400)' };
    case 'rejected':
      return { label: 'Rejected', bg: 'hsla(0, 84%, 60%, 0.15)', color: 'var(--color-error-400)' };
    case 'archived':
      return { label: 'Archived', bg: 'hsla(215, 20%, 50%, 0.15)', color: 'var(--text-muted)' };
    case 'draft':
    default:
      return { label: 'Draft', bg: 'hsla(45, 90%, 50%, 0.15)', color: 'var(--color-warning-400)' };
  }
}

export default function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

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

  // UI state
  const [isEditing, setIsEditing] = useState(false);
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

  // New Attachment state
  const [newAttFileId, setNewAttFileId] = useState('');
  const [newAttLabel, setNewAttLabel] = useState('');
  const [attAdding, setAttAdding] = useState(false);

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
    setIsEditing(true);
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

    try {
      await updateDoc.mutateAsync({
        id: doc.id,
        data: {
          title: editTitle.trim(),
          priority: editPriority,
          dept_id: editDeptId || null,
          due_at: editDueAt ? new Date(editDueAt).toISOString() : null,
          form_data: editFormData,
          change_reason: 'Updated document details',
        },
      });
      setIsEditing(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update document';
      setGeneralError(msg);
    }
  };

  const handleSubmitDoc = async () => {
    if (window.confirm('Submit this draft document for review/approval?')) {
      await submitDoc.mutateAsync({ id: doc.id, changeReason: 'Submitted for approval' });
    }
  };

  const handleAddAttachment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAttFileId.trim()) return;

    try {
      setAttAdding(true);
      await addAtt.mutateAsync({
        docId: doc.id,
        data: {
          file_asset_id: newAttFileId.trim(),
          label: newAttLabel.trim() || undefined,
        },
      });
      setNewAttFileId('');
      setNewAttLabel('');
    } catch {
      // Handled
    } finally {
      setAttAdding(false);
    }
  };

  const handleRemoveAtt = async (attId: string) => {
    if (window.confirm('Remove this attachment?')) {
      await removeAtt.mutateAsync({ docId: doc.id, attId });
    }
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
                background: 'hsla(217, 100%, 50%, 0.1)',
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
            style={{
              fontSize: '1.85rem',
              fontWeight: 800,
              color: 'var(--text-primary)',
              marginTop: '8px',
            }}
          >
            {isEditing ? (
              <input
                type="text"
                className="input"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
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

          {isEditing ? (
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
                disabled={updateDoc.isPending}
              >
                {updateDoc.isPending ? 'Saving...' : 'Save Changes'}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={startEdit}
                className="btn btn-secondary"
              >
                Edit Document
              </button>

              {doc.status === 'draft' && (
                <button
                  onClick={handleSubmitDoc}
                  className="btn btn-primary"
                  disabled={submitDoc.isPending}
                  style={{ background: 'var(--color-primary-600)' }}
                >
                  Submit for Approval →
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {generalError && (
        <div
          style={{
            padding: '14px 18px',
            background: 'hsla(0, 84%, 60%, 0.12)',
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
                  setEditFormData((prev) => ({ ...prev, [key]: val }));
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
                    onChange={(e) => setEditPriority(e.target.value)}
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
                    onChange={(e) => setEditDeptId(e.target.value)}
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
                    onChange={(e) => setEditDueAt(e.target.value)}
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
              <input
                type="text"
                className="input"
                placeholder="Enter File Asset UUID..."
                value={newAttFileId}
                onChange={(e) => setNewAttFileId(e.target.value)}
                style={{ fontSize: '0.8rem' }}
              />
              <input
                type="text"
                className="input"
                placeholder="Label (e.g. Signed contract PDF)..."
                value={newAttLabel}
                onChange={(e) => setNewAttLabel(e.target.value)}
                style={{ fontSize: '0.8rem' }}
              />
              <button
                type="submit"
                disabled={!newAttFileId.trim() || attAdding}
                className="btn btn-secondary btn-sm"
                style={{ width: '100%' }}
              >
                {attAdding ? 'Attaching...' : '+ Attach File Asset'}
              </button>
            </form>
          </div>
        </div>
      </div>

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
    </div>
  );
}
