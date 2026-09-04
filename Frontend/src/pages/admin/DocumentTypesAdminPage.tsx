/**
 * DocFlow Frontend — Page: DocumentTypesAdminPage (/admin/document-types)
 * Admin workspace for managing organization Document Types and visual Form Schemas,
 * featuring an interactive custom form field builder (types, keys, required toggles, select options).
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  useDocumentTypes,
  useCreateDocumentType,
  useUpdateDocumentType,
  useDeleteDocumentType,
} from '@/hooks/useDocuments';
import type { DocumentType, FormField } from '@/types';

export default function DocumentTypesAdminPage() {
  const { data: types = [], isLoading } = useDocumentTypes(false);
  const createType = useCreateDocumentType();
  const updateType = useUpdateDocumentType();
  const deleteType = useDeleteDocumentType();

  // Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [editingType, setEditingType] = useState<DocumentType | null>(null);

  // Form State
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('General');
  const [retentionDays, setRetentionDays] = useState<number | ''>('');
  const [formSchema, setFormSchema] = useState<FormField[]>([]);
  const [generalError, setGeneralError] = useState('');

  const openNewModal = () => {
    setEditingType(null);
    setName('');
    setCode('');
    setDescription('');
    setCategory('General');
    setRetentionDays('');
    setFormSchema([
      { key: 'department_ref', label: 'Department Reference', type: 'text', required: false },
    ]);
    setGeneralError('');
    setModalOpen(true);
  };

  const openEditModal = (dt: DocumentType) => {
    setEditingType(dt);
    setName(dt.name);
    setCode(dt.code);
    setDescription(dt.description || '');
    setCategory(dt.category || 'General');
    setRetentionDays(dt.retention_days ?? '');
    setFormSchema(dt.form_schema ? JSON.parse(JSON.stringify(dt.form_schema)) : []);
    setGeneralError('');
    setModalOpen(true);
  };

  // Field Builder Actions
  const addField = () => {
    setFormSchema((prev) => [
      ...prev,
      {
        key: `field_${prev.length + 1}`,
        label: 'New Custom Field',
        type: 'text',
        required: false,
      },
    ]);
  };

  const updateField = (index: number, changes: Partial<FormField>) => {
    setFormSchema((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...changes };
      return next;
    });
  };

  const removeField = (index: number) => {
    setFormSchema((prev) => prev.filter((_, i) => i !== index));
  };

  const moveField = (index: number, direction: 'up' | 'down') => {
    setFormSchema((prev) => {
      const next = [...prev];
      const targetIdx = direction === 'up' ? index - 1 : index + 1;
      if (targetIdx < 0 || targetIdx >= next.length) return prev;
      const tmp = next[index];
      next[index] = next[targetIdx];
      next[targetIdx] = tmp;
      return next;
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneralError('');

    if (!name.trim() || !code.trim()) {
      setGeneralError('Name and Code are required.');
      return;
    }

    // Ensure all keys are formatted and unique
    const keysSet = new Set<string>();
    for (const f of formSchema) {
      if (!f.key.trim() || !f.label.trim()) {
        setGeneralError('All schema fields must have a valid Key and Label.');
        return;
      }
      if (keysSet.has(f.key)) {
        setGeneralError(`Duplicate field key: "${f.key}". Keys must be unique.`);
        return;
      }
      keysSet.add(f.key);
    }

    try {
      if (editingType) {
        await updateType.mutateAsync({
          id: editingType.id,
          data: {
            name: name.trim(),
            code: code.trim().toUpperCase(),
            description: description.trim() || undefined,
            category: category.trim() || undefined,
            retention_days: retentionDays === '' ? undefined : Number(retentionDays),
            form_schema: formSchema,
          },
        });
      } else {
        await createType.mutateAsync({
          name: name.trim(),
          code: code.trim().toUpperCase(),
          description: description.trim() || undefined,
          category: category.trim() || undefined,
          retention_days: retentionDays === '' ? undefined : Number(retentionDays),
          form_schema: formSchema,
        });
      }
      setModalOpen(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save document type.';
      setGeneralError(msg);
    }
  };

  const handleToggleActive = async (dt: DocumentType) => {
    await updateType.mutateAsync({
      id: dt.id,
      data: { is_active: !dt.is_active },
    });
  };

  const handleDelete = async (dt: DocumentType) => {
    if (window.confirm(`Delete document type "${dt.name}" (${dt.code})?`)) {
      await deleteType.mutateAsync(dt.id);
    }
  };

  return (
    <div style={{ padding: '32px', maxWidth: '1280px', margin: '0 auto' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '32px',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>
            Document Types & Form Schemas
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
            Define structured metadata templates and custom form schemas for document workflows.
          </p>
        </div>
        <button onClick={openNewModal} className="btn btn-primary" style={{ padding: '10px 22px' }}>
          + New Document Type
        </button>
      </div>

      {/* Table */}
      <div className="glass-card" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              textAlign: 'left',
              minWidth: '800px',
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: '1px solid var(--border-subtle)',
                  background: 'var(--bg-overlay)',
                  color: 'var(--text-secondary)',
                  fontSize: '0.78rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                <th style={{ padding: '14px 20px' }}>Code</th>
                <th style={{ padding: '14px 20px' }}>Name</th>
                <th style={{ padding: '14px 20px' }}>Category</th>
                <th style={{ padding: '14px 20px' }}>Form Schema</th>
                <th style={{ padding: '14px 20px' }}>Retention</th>
                <th style={{ padding: '14px 20px' }}>Status</th>
                <th style={{ padding: '14px 20px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} style={{ padding: '64px', textAlign: 'center' }}>
                    <div className="spinner" style={{ width: '32px', height: '32px', margin: '0 auto' }} />
                  </td>
                </tr>
              ) : types.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: '64px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    No document types created yet. Click "+ New Document Type" to define one.
                  </td>
                </tr>
              ) : (
                types.map((dt) => (
                  <tr
                    key={dt.id}
                    style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      transition: 'background-color var(--transition-fast)',
                    }}
                  >
                    {/* Code */}
                    <td style={{ padding: '16px 20px' }}>
                      <span
                        style={{
                          fontFamily: 'monospace',
                          fontWeight: 700,
                          fontSize: '0.85rem',
                          color: 'var(--color-primary-400)',
                          background: 'hsla(217, 100%, 50%, 0.1)',
                          padding: '4px 8px',
                          borderRadius: 'var(--radius-sm)',
                        }}
                      >
                        {dt.code}
                      </span>
                    </td>

                    {/* Name */}
                    <td style={{ padding: '16px 20px' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.92rem', color: 'var(--text-primary)' }}>
                        {dt.name}
                      </div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {dt.description || 'No description'}
                      </div>
                    </td>

                    {/* Category */}
                    <td style={{ padding: '16px 20px' }}>
                      <span
                        style={{
                          fontSize: '0.8rem',
                          fontWeight: 600,
                          color: 'var(--text-secondary)',
                          background: 'var(--bg-overlay)',
                          padding: '4px 10px',
                          borderRadius: 'var(--radius-md)',
                          border: '1px solid var(--border-subtle)',
                        }}
                      >
                        {dt.category || 'General'}
                      </span>
                    </td>

                    {/* Form Schema Count */}
                    <td style={{ padding: '16px 20px' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {dt.form_schema?.length || 0} field(s)
                      </span>
                    </td>

                    {/* Retention */}
                    <td style={{ padding: '16px 20px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      {dt.retention_days ? `${dt.retention_days} days` : 'Infinite'}
                    </td>

                    {/* Status Toggle */}
                    <td style={{ padding: '16px 20px' }}>
                      <button
                        onClick={() => handleToggleActive(dt)}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 'var(--radius-full)',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          cursor: 'pointer',
                          border: 'none',
                          background: dt.is_active
                            ? 'hsla(150, 80%, 40%, 0.15)'
                            : 'hsla(0, 0%, 50%, 0.15)',
                          color: dt.is_active
                            ? 'var(--color-success-400)'
                            : 'var(--text-muted)',
                        }}
                      >
                        {dt.is_active ? 'Active' : 'Inactive'}
                      </button>
                    </td>

                    {/* Actions */}
                    <td style={{ padding: '16px 20px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                        <button
                          onClick={() => openEditModal(dt)}
                          className="btn btn-ghost btn-sm"
                          style={{ fontSize: '0.78rem' }}
                        >
                          Edit Schema
                        </button>
                        <button
                          onClick={() => handleDelete(dt)}
                          className="btn btn-ghost btn-sm"
                          style={{ fontSize: '0.78rem', color: 'var(--color-error-400)' }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Schema Builder Modal */}
      <AnimatePresence>
        {modalOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setModalOpen(false)}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'hsla(220, 50%, 5%, 0.75)',
                backdropFilter: 'blur(6px)',
                zIndex: 300,
              }}
            />

            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.97 }}
              style={{
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '94%',
                maxWidth: '860px',
                maxHeight: '88vh',
                zIndex: 301,
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 'var(--radius-xl)',
                overflow: 'hidden',
                boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
              }}
              className="glass-card"
            >
              {/* Modal Header */}
              <div
                style={{
                  padding: '20px 28px',
                  borderBottom: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                    {editingType ? `Edit Schema: ${editingType.name}` : 'New Document Type Schema'}
                  </h2>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Define the document code and configure custom input fields.
                  </p>
                </div>
                <button
                  onClick={() => setModalOpen(false)}
                  style={{
                    background: 'var(--bg-overlay)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                  }}
                >
                  ✕
                </button>
              </div>

              {/* Modal Form Content */}
              <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                <div
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: '24px 28px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '24px',
                  }}
                >
                  {generalError && (
                    <div
                      style={{
                        padding: '12px 16px',
                        background: 'hsla(0, 84%, 60%, 0.12)',
                        border: '1px solid var(--color-error-400)',
                        borderRadius: 'var(--radius-md)',
                        color: 'var(--color-error-400)',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                      }}
                    >
                      ⚠️ {generalError}
                    </div>
                  )}

                  {/* Top: Metadata properties */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                        Document Type Name <span style={{ color: 'var(--color-error-400)' }}>*</span>
                      </label>
                      <input
                        type="text"
                        className="input"
                        placeholder="e.g. Master Services Agreement"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                      />
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                        Type Code <span style={{ color: 'var(--color-error-400)' }}>*</span>
                      </label>
                      <input
                        type="text"
                        className="input"
                        placeholder="e.g. MSA, FIN-INV, NDA"
                        value={code}
                        onChange={(e) => setCode(e.target.value.toUpperCase())}
                        required
                        style={{ fontFamily: 'monospace' }}
                      />
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                        Category
                      </label>
                      <select
                        className="input"
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                      >
                        <option value="General">General</option>
                        <option value="Legal">Legal</option>
                        <option value="Finance">Finance</option>
                        <option value="HR">HR</option>
                        <option value="Engineering">Engineering</option>
                        <option value="Executive">Executive</option>
                      </select>
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                        Retention Period (Days)
                      </label>
                      <input
                        type="number"
                        className="input"
                        placeholder="e.g. 365 (leave empty for infinite)"
                        value={retentionDays}
                        onChange={(e) => setRetentionDays(e.target.value === '' ? '' : Number(e.target.value))}
                      />
                    </div>

                    <div style={{ gridColumn: 'span 2' }}>
                      <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                        Description (Optional)
                      </label>
                      <input
                        type="text"
                        className="input"
                        placeholder="Short summary of when to use this document type..."
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Schema Builder Section */}
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: '16px',
                        paddingBottom: '10px',
                        borderBottom: '1px solid var(--border-subtle)',
                      }}
                    >
                      <div>
                        <h3 style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                          Custom Form Schema ({formSchema.length})
                        </h3>
                        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                          Configure fields that users must fill when submitting this document type.
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={addField}
                        className="btn btn-secondary btn-sm"
                        style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700 }}
                      >
                        + Add Custom Field
                      </button>
                    </div>

                    {formSchema.length === 0 ? (
                      <div
                        style={{
                          padding: '32px',
                          textAlign: 'center',
                          border: '1px dashed var(--border-subtle)',
                          borderRadius: 'var(--radius-lg)',
                          color: 'var(--text-muted)',
                          fontSize: '0.88rem',
                        }}
                      >
                        No custom fields configured. Click "+ Add Custom Field" above.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {formSchema.map((field, index) => (
                          <div
                            key={index}
                            style={{
                              padding: '16px 18px',
                              background: 'var(--bg-overlay)',
                              border: '1px solid var(--border-subtle)',
                              borderRadius: 'var(--radius-lg)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '12px',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '12px',
                                flexWrap: 'wrap',
                              }}
                            >
                              {/* Label */}
                              <div style={{ flex: '1 1 200px' }}>
                                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                                  Field Label
                                </label>
                                <input
                                  type="text"
                                  className="input"
                                  placeholder="e.g. Total Amount"
                                  value={field.label}
                                  onChange={(e) => {
                                    const lbl = e.target.value;
                                    const key = lbl.toLowerCase().replace(/[^a-z0-9_]/g, '_');
                                    updateField(index, { label: lbl, key });
                                  }}
                                  style={{ fontSize: '0.85rem' }}
                                />
                              </div>

                              {/* Key */}
                              <div style={{ width: '170px' }}>
                                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                                  Field Key
                                </label>
                                <input
                                  type="text"
                                  className="input"
                                  placeholder="e.g. total_amount"
                                  value={field.key}
                                  onChange={(e) => updateField(index, { key: e.target.value })}
                                  style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
                                />
                              </div>

                              {/* Type */}
                              <div style={{ width: '150px' }}>
                                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                                  Field Type
                                </label>
                                <select
                                  className="input"
                                  value={field.type}
                                  onChange={(e) =>
                                    updateField(index, {
                                      type: e.target.value as FormField['type'],
                                    })
                                  }
                                  style={{ fontSize: '0.85rem' }}
                                >
                                  <option value="text">Text Input</option>
                                  <option value="textarea">Textarea</option>
                                  <option value="number">Number</option>
                                  <option value="date">Date Picker</option>
                                  <option value="select">Select (Dropdown)</option>
                                  <option value="multiselect">Multi-select</option>
                                  <option value="checkbox">Checkbox (Toggle)</option>
                                  <option value="file">File Attachment</option>
                                </select>
                              </div>

                              {/* Required Toggle */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '18px' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 }}>
                                  <input
                                    type="checkbox"
                                    checked={field.required}
                                    onChange={(e) => updateField(index, { required: e.target.checked })}
                                    style={{ width: '16px', height: '16px', accentColor: 'var(--color-primary-500)' }}
                                  />
                                  <span>Required</span>
                                </label>
                              </div>

                              {/* Up/Down/Delete Controls */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', paddingTop: '18px' }}>
                                <button
                                  type="button"
                                  disabled={index === 0}
                                  onClick={() => moveField(index, 'up')}
                                  className="btn btn-ghost btn-sm"
                                  title="Move Up"
                                  style={{ padding: '4px 8px' }}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  disabled={index === formSchema.length - 1}
                                  onClick={() => moveField(index, 'down')}
                                  className="btn btn-ghost btn-sm"
                                  title="Move Down"
                                  style={{ padding: '4px 8px' }}
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  onClick={() => removeField(index)}
                                  className="btn btn-ghost btn-sm"
                                  title="Remove Field"
                                  style={{ color: 'var(--color-error-400)', padding: '4px 8px' }}
                                >
                                  ✕
                                </button>
                              </div>
                            </div>

                            {/* Select options row if type is select or multiselect */}
                            {(field.type === 'select' || field.type === 'multiselect') && (
                              <div style={{ padding: '10px 14px', background: 'var(--bg-card)', borderRadius: 'var(--radius-md)' }}>
                                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '4px' }}>
                                  Options (Comma-separated values, e.g. "Draft, Confidential, Final")
                                </label>
                                <input
                                  type="text"
                                  className="input"
                                  placeholder="Enter options..."
                                  value={(field.options || []).map((o) => o.label).join(', ')}
                                  onChange={(e) => {
                                    const opts = e.target.value
                                      .split(',')
                                      .map((s) => s.trim())
                                      .filter(Boolean)
                                      .map((s) => ({ value: s, label: s }));
                                    updateField(index, { options: opts });
                                  }}
                                  style={{ fontSize: '0.8rem' }}
                                />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Footer */}
                <div
                  style={{
                    padding: '16px 28px',
                    borderTop: '1px solid var(--border-subtle)',
                    background: 'var(--bg-card)',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: '12px',
                  }}
                >
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setModalOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={createType.isPending || updateType.isPending}
                    style={{ padding: '10px 24px', fontWeight: 700 }}
                  >
                    {createType.isPending || updateType.isPending ? 'Saving Schema...' : 'Save Document Type'}
                  </button>
                </div>
              </form>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
