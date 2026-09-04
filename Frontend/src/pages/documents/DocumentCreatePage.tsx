/**
 * DocFlow Frontend — Page: DocumentCreatePage (/documents/new)
 * 2-Step interactive document creation workflow:
 * Step 1: Select an organization document type from visual cards.
 * Step 2: Fill general properties and dynamic form schema fields with validation.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  useDocumentTypes,
  useCreateDocument,
} from '@/hooks/useDocuments';
import { useDepartments } from '@/hooks/useOrg';
import type { DocumentType } from '@/types';
import DynamicFormRenderer, { validateFormSchema } from '@/components/documents/DynamicFormRenderer';

export default function DocumentCreatePage() {
  const navigate = useNavigate();

  // Step state (1: Select Type, 2: Fill Form)
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedType, setSelectedType] = useState<DocumentType | null>(null);

  // Common properties
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('normal');
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
      const newDoc = await createDoc.mutateAsync({
        doc_type_id: selectedType.id,
        title: title.trim(),
        priority,
        dept_id: deptId || null,
        due_at: dueAt ? new Date(dueAt).toISOString() : null,
        form_data: formData,
        metadata: {},
        submit_immediately: submitImmediately,
      });

      navigate(`/documents/${newDoc.id}`);
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
                Your organization administrator needs to create document types before documents can be submitted.
              </p>
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
              {createDoc.isPending ? 'Submitting...' : 'Submit Immediately →'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
