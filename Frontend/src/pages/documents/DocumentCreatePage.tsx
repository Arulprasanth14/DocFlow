/**
 * DocFlow Frontend — Page: DocumentCreatePage (/documents/new)
 * 2-Step interactive document creation workflow:
 * Step 1: Select an organization document type from visual cards.
 * Step 2: Fill general properties and dynamic form schema fields with validation.
 */

import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  useDocumentTypes,
  useCreateDocument,
  useUploadFile,
  useAddDocumentAttachment,
} from '@/hooks/useDocuments';
import { useDepartments } from '@/hooks/useOrg';
import { useAuthStore } from '@/store/authStore';
import type { DocumentType } from '@/types';
import DynamicFormRenderer, { validateFormSchema } from '@/components/documents/DynamicFormRenderer';

// Matches Backend/app/core/storage.py MAX_FILE_SIZE_BYTES / ALLOWED_MIME_TYPES.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
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

export default function DocumentCreatePage() {
  const navigate = useNavigate();

  // Step state (1: Select Type, 2: Fill Form)
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

  // Queries & mutations
  const { data: docTypes = [], isLoading: typesLoading } = useDocumentTypes(true);
  const { data: departments = [] } = useDepartments(true);
  const createDoc = useCreateDocument();
  const uploadFile = useUploadFile();
  const addAttachment = useAddDocumentAttachment();
  const canManageDocTypes = useAuthStore((s) => s.hasPermission('admin:doc_types'));

  // "Create from scratch" / "Upload existing document" both need *some*
  // DocumentType to satisfy the required doc_type_id FK, but neither wants
  // a schema-driven form — so both use the first type with no custom
  // fields defined (e.g. the "General Document" type seeded for every new
  // org). If an org only has schema-driven types, these two options are
  // disabled rather than fabricating a fake type client-side.
  const blankType = docTypes.find((dt) => !dt.form_schema || dt.form_schema.length === 0) || null;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const handleUploadFileSelected = async (file: File | null) => {
    if (!file || !blankType) return;
    setUploadError('');
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError(`File is too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
      return;
    }
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      setUploadError(`File type "${file.type || 'unknown'}" is not allowed`);
      return;
    }
    setUploadBusy(true);
    try {
      const newDoc = await createDoc.mutateAsync({
        doc_type_id: blankType.id,
        title: file.name.replace(/\.[^.]+$/, '') || file.name,
        priority: 'normal',
        tags: [],
        form_data: {},
        metadata: {},
        submit_immediately: false,
      });
      const fileAssetId = await uploadFile.mutateAsync(file);
      await addAttachment.mutateAsync({ docId: newDoc.id, data: { file_asset_id: fileAssetId } });
      navigate(`/documents/${newDoc.id}`);
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : 'Failed to upload document.');
      setUploadBusy(false);
    }
  };

  const handleTypeSelect = (dt: DocumentType) => {
    setSelectedType(dt);
    setFormData({});
    setFormErrors({});
    setStep(2);
  };

  const handleFieldChange = (key: string, value: unknown) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    if (formErrors[key]) {
      setFormErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const handleSubmit = async (submitImmediately: boolean) => {
    setGeneralError('');
    if (!title.trim()) {
      setGeneralError('Document Title is required.');
      return;
    }

    if (!selectedType) return;

    // Validate dynamic form schema
    const validation = validateFormSchema(selectedType.form_schema || [], formData);
    if (!validation.isValid) {
      setFormErrors(validation.errors);
      setGeneralError('Please fix the highlighted errors in the custom fields.');
      return;
    }

    try {
      // Always create as a draft — "submit immediately" used to flip the
      // document straight to SUBMITTED status without ever starting an
      // approval workflow (no template, no approvers, no ApprovalStep),
      // which left it permanently stuck with no way forward. Approvers,
      // their sequence, and a deadline must be configured and reviewed
      // first (see SubmitWorkflowModal), so "Submit" here just takes the
      // user straight to that review step instead of submitting blind.
      const newDoc = await createDoc.mutateAsync({
        doc_type_id: selectedType.id,
        title: title.trim(),
        priority,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        dept_id: deptId || null,
        due_at: dueAt ? new Date(dueAt).toISOString() : null,
        form_data: formData,
        metadata: {},
        submit_immediately: false,
      });

      navigate(`/documents/${newDoc.id}`, { state: submitImmediately ? { openSubmit: true } : undefined });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create document.';
      setGeneralError(msg);
    }
  };

  return (
    <div style={{ padding: '32px', maxWidth: '1000px', margin: '0 auto' }}>
      {/* Top Header */}
      <div style={{ marginBottom: '28px' }}>
        <button
          onClick={() => (step === 2 ? setStep(1) : navigate('/documents'))}
          className="btn btn-ghost btn-sm"
          style={{ marginBottom: '12px', paddingLeft: 0, color: 'var(--text-secondary)' }}
        >
          ← {step === 2 ? 'Change Document Type' : 'Back to Repository'}
        </button>

        <h1 style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>
          {step === 1 ? 'Choose Document Type' : `Create ${selectedType?.name || 'Document'}`}
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
          {step === 1
            ? 'Select the template that matches your organizational workflow.'
            : 'Fill in the document properties and required custom fields below.'}
        </p>
      </div>

      {/* STEP 1: Select Document Type */}
      {step === 1 && (
        <div>
          {/* Alternatives to picking a structured template */}
          {!typesLoading && (
            <div
              style={{
                display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '24px',
                padding: '16px', borderRadius: 'var(--radius-md)',
                background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ flex: '1 1 auto', minWidth: '200px' }}>
                <p style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '2px' }}>
                  Don't see a suitable template?
                </p>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  Start blank, or upload a file you already have.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!blankType}
                title={!blankType ? 'Ask your admin to create a general-purpose document type with no custom fields first' : undefined}
                onClick={() => blankType && handleTypeSelect(blankType)}
              >
                + Create Blank Document
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!blankType || uploadBusy}
                title={!blankType ? 'Ask your admin to create a general-purpose document type with no custom fields first' : undefined}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadBusy ? 'Uploading...' : '📎 Upload Existing Document'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  handleUploadFileSelected(file);
                  e.target.value = '';
                }}
              />
            </div>
          )}

          {uploadError && (
            <div
              style={{
                padding: '12px 16px', marginBottom: '20px', borderRadius: 'var(--radius-md)',
                background: 'hsla(0, 84%, 60%, 0.12)', border: '1px solid var(--color-error-400)',
                color: 'var(--color-error-400)', fontSize: '0.85rem', fontWeight: 600,
              }}
            >
              ⚠️ {uploadError}
            </div>
          )}

          {typesLoading ? (
            <div style={{ padding: '64px', textAlign: 'center' }}>
              <div className="spinner" style={{ width: '36px', height: '36px', margin: '0 auto' }} />
            </div>
          ) : docTypes.length === 0 ? (
            <div
              className="glass-card"
              style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}
            >
              <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>📄</div>
              <h3 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
                No Active Document Types
              </h3>
              <p style={{ fontSize: '0.9rem', marginBottom: '20px' }}>
                {canManageDocTypes
                  ? "You're an admin, so you can fix this yourself — create a document type to get started."
                  : 'Your organization administrator needs to create document types before documents can be submitted.'}
              </p>
              {canManageDocTypes && (
                <button
                  className="btn btn-primary"
                  onClick={() => navigate('/admin/document-types')}
                >
                  Create a Document Type →
                </button>
              )}
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: '20px',
              }}
            >
              {docTypes.map((dt) => (
                <motion.div
                  key={dt.id}
                  onClick={() => handleTypeSelect(dt)}
                  whileHover={{ y: -4, borderColor: 'var(--color-primary-500)' }}
                  className="glass-card"
                  style={{
                    padding: '24px',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    minHeight: '180px',
                    border: '1px solid var(--border-subtle)',
                    transition: 'all var(--transition-fast)',
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: '12px',
                      }}
                    >
                      <span
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: 'var(--color-primary-400)',
                          background: 'hsla(217, 100%, 50%, 0.1)',
                          padding: '4px 8px',
                          borderRadius: 'var(--radius-sm)',
                        }}
                      >
                        {dt.category || 'General'}
                      </span>
                      <span
                        style={{
                          fontSize: '0.75rem',
                          fontFamily: 'monospace',
                          fontWeight: 700,
                          color: 'var(--text-muted)',
                        }}
                      >
                        {dt.code}
                      </span>
                    </div>

                    <h3
                      style={{
                        fontSize: '1.15rem',
                        fontWeight: 800,
                        color: 'var(--text-primary)',
                        marginBottom: '8px',
                      }}
                    >
                      {dt.name}
                    </h3>
                    <p
                      style={{
                        fontSize: '0.85rem',
                        color: 'var(--text-muted)',
                        lineHeight: 1.5,
                      }}
                    >
                      {dt.description || 'No description provided.'}
                    </p>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginTop: '20px',
                      paddingTop: '12px',
                      borderTop: '1px solid var(--border-subtle)',
                      fontSize: '0.8rem',
                      color: 'var(--text-secondary)',
                      fontWeight: 600,
                    }}
                  >
                    <span>{dt.form_schema?.length || 0} Custom Field(s)</span>
                    <span style={{ color: 'var(--color-primary-400)' }}>Select →</span>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* STEP 2: Fill General & Custom Fields */}
      {step === 2 && selectedType && (
        <div className="glass-card" style={{ padding: '32px' }}>
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
                marginBottom: '24px',
              }}
            >
              ⚠️ {generalError}
            </div>
          )}

          {/* Section 1: General Properties */}
          <div style={{ marginBottom: '32px' }}>
            <h3
              style={{
                fontSize: '1.1rem',
                fontWeight: 800,
                color: 'var(--text-primary)',
                marginBottom: '16px',
                paddingBottom: '10px',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              General Information
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
              {/* Title */}
              <div style={{ gridColumn: 'span 2' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    marginBottom: '6px',
                  }}
                >
                  Document Title <span style={{ color: 'var(--color-error-400)' }}>*</span>
                </label>
                <input
                  type="text"
                  className="input"
                  placeholder="e.g. Q3 Marketing Budget Plan, Legal MSA for Partner X"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                />
              </div>

              {/* Priority */}
              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    marginBottom: '6px',
                  }}
                >
                  Priority
                </label>
                <select
                  className="input"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                >
                  <option value="normal">• Normal</option>
                  <option value="high">⚡ High</option>
                  <option value="urgent">🔥 Urgent</option>
                  <option value="low">💤 Low</option>
                </select>
              </div>

              {/* Tags */}
              <div style={{ gridColumn: 'span 2' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    marginBottom: '6px',
                  }}
                >
                  Tags (comma-separated)
                </label>
                <input
                  type="text"
                  className="input"
                  placeholder="e.g. urgent, legal, q3"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                />
              </div>

              {/* Department */}
              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    marginBottom: '6px',
                  }}
                >
                  Department (Optional)
                </label>
                <select
                  className="input"
                  value={deptId}
                  onChange={(e) => setDeptId(e.target.value)}
                >
                  <option value="">— Unassigned —</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Due Date */}
              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    marginBottom: '6px',
                  }}
                >
                  Target Due Date (Optional)
                </label>
                <input
                  type="date"
                  className="input"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Section 2: Custom Form Fields */}
          <div style={{ marginBottom: '36px' }}>
            <h3
              style={{
                fontSize: '1.1rem',
                fontWeight: 800,
                color: 'var(--text-primary)',
                marginBottom: '16px',
                paddingBottom: '10px',
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>Custom Form Fields ({selectedType.name})</span>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                {selectedType.form_schema?.length || 0} field(s) defined
              </span>
            </h3>

            <DynamicFormRenderer
              schema={selectedType.form_schema || []}
              values={formData}
              onChange={handleFieldChange}
              errors={formErrors}
            />
          </div>

          {/* Actions */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: '12px',
              paddingTop: '20px',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <button
              type="button"
              className="btn btn-secondary"
              disabled={createDoc.isPending}
              onClick={() => handleSubmit(false)}
              style={{ padding: '10px 22px', fontSize: '0.9rem' }}
            >
              Save as Draft
            </button>

            <button
              type="button"
              className="btn btn-primary"
              disabled={createDoc.isPending}
              onClick={() => handleSubmit(true)}
              style={{ padding: '10px 24px', fontSize: '0.9rem', fontWeight: 700 }}
            >
              {createDoc.isPending ? 'Creating...' : 'Continue to Submit →'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
