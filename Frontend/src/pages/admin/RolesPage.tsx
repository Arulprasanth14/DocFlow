/**
 * DocFlow Frontend — Admin: Roles & Permissions Page
 * Manage system and custom roles with an interactive permission matrix modal.
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { motion, AnimatePresence } from 'framer-motion';
import {
  useRoles,
  usePermissions,
  useCreateRole,
  useUpdateRole,
  useSetRolePermissions,
  useDeleteRole,
} from '@/hooks/useOrg';
import type { Role } from '@/types';

interface RoleFormData {
  name: string;
  description: string;
}

export default function RolesPage() {
  const { data: roles = [], isLoading: rolesLoading } = useRoles();
  const { data: catalog, isLoading: permsLoading } = usePermissions();

  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const setRolePermissions = useSetRolePermissions();
  const deleteRole = useDeleteRole();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);

  const [matrixOpen, setMatrixOpen] = useState(false);
  const [activeRoleForMatrix, setActiveRoleForMatrix] = useState<Role | null>(null);
  const [selectedPerms, setSelectedPerms] = useState<string[]>([]);

  const { register, handleSubmit, reset } = useForm<RoleFormData>();

  const openNewRole = () => {
    setEditingRole(null);
    reset({ name: '', description: '' });
    setModalOpen(true);
  };

  const openEditRole = (role: Role) => {
    setEditingRole(role);
    reset({
      name: role.name,
      description: role.description || '',
    });
    setModalOpen(true);
  };

  const onSaveRole = async (data: RoleFormData) => {
    try {
      if (editingRole) {
        await updateRole.mutateAsync({
          id: editingRole.id,
          data: { name: data.name, description: data.description || undefined },
        });
      } else {
        await createRole.mutateAsync({
          name: data.name,
          description: data.description || undefined,
          permissions: [],
        });
      }
      setModalOpen(false);
    } catch {
      // Error handled
    }
  };

  const onDeleteRole = async (role: Role) => {
    if (role.is_system) return;
    if ((role.member_count ?? 0) > 0) {
      alert(`Cannot delete role '${role.name}' because ${role.member_count} member(s) are assigned to it.`);
      return;
    }
    if (window.confirm(`Are you sure you want to delete role '${role.name}'?`)) {
      await deleteRole.mutateAsync(role.id);
    }
  };

  const openMatrix = (role: Role) => {
    setActiveRoleForMatrix(role);
    setSelectedPerms(role.permissions || []);
    setMatrixOpen(true);
  };

  const togglePermission = (code: string) => {
    if (selectedPerms.includes(code)) {
      setSelectedPerms(selectedPerms.filter((p) => p !== code));
    } else {
      setSelectedPerms([...selectedPerms, code]);
    }
  };

  const toggleCategory = (codes: string[]) => {
    const allSelected = codes.every((code) => selectedPerms.includes(code));
    if (allSelected) {
      setSelectedPerms(selectedPerms.filter((p) => !codes.includes(p)));
    } else {
      const newSet = new Set([...selectedPerms, ...codes]);
      setSelectedPerms(Array.from(newSet));
    }
  };

  const savePermissionsMatrix = async () => {
    if (!activeRoleForMatrix) return;
    try {
      await setRolePermissions.mutateAsync({
        id: activeRoleForMatrix.id,
        permissions: selectedPerms,
      });
      setMatrixOpen(false);
    } catch {
      // Error handled
    }
  };

  if (rolesLoading || permsLoading) {
    return (
      <div style={{ padding: '40px', display: 'flex', justifyContent: 'center' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  const categories = catalog?.by_category || {};

  return (
    <div style={{ padding: '32px', maxWidth: '1100px', margin: '0 auto' }}>
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
            Roles & Permissions
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
            Configure access control policies and permission sets across documents and workflows.
          </p>
        </div>
        <button onClick={openNewRole} className="btn btn-primary">
          + New Role
        </button>
      </div>

      {/* Role Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: '20px',
        }}
      >
        {roles.map((role, idx) => {
          const isSystem = role.is_system;
          const memberCount = role.member_count ?? 0;

          return (
            <motion.div
              key={role.id}
              className="glass-card"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
              style={{
                padding: '24px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                position: 'relative',
                borderTop: isSystem ? '2px solid var(--color-accent-500)' : '2px solid var(--color-primary-500)',
              }}
            >
              <div>
                {/* Title & Badge */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <h3 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {role.name}
                  </h3>
                  {isSystem ? (
                    <span
                      style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        color: 'var(--color-accent-300)',
                        background: 'hsla(258, 90%, 65%, 0.15)',
                        border: '1px solid hsla(258, 90%, 65%, 0.3)',
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-full)',
                      }}
                    >
                      🔒 System Role
                    </span>
                  ) : (
                    <span
                      style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        color: 'var(--color-primary-300)',
                        background: 'hsla(217, 100%, 50%, 0.15)',
                        border: '1px solid hsla(217, 100%, 50%, 0.3)',
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-full)',
                      }}
                    >
                      Custom Role
                    </span>
                  )}
                </div>

                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '16px', minHeight: '36px' }}>
                  {role.description || 'No description provided.'}
                </p>

                {/* Permission Badges Preview */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '20px' }}>
                  {(role.permissions || []).slice(0, 5).map((p) => (
                    <span
                      key={p}
                      style={{
                        fontSize: '0.72rem',
                        color: 'var(--text-secondary)',
                        background: 'var(--bg-overlay)',
                        padding: '3px 8px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      {p}
                    </span>
                  ))}
                  {(role.permissions || []).length > 5 && (
                    <span
                      style={{
                        fontSize: '0.72rem',
                        color: 'var(--color-primary-300)',
                        background: 'hsla(217, 100%, 50%, 0.1)',
                        padding: '3px 8px',
                        borderRadius: 'var(--radius-sm)',
                        fontWeight: 600,
                      }}
                    >
                      +{(role.permissions || []).length - 5} more
                    </span>
                  )}
                </div>
              </div>

              {/* Footer */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderTop: '1px solid var(--border-subtle)',
                  paddingTop: '16px',
                }}
              >
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  👤 <strong>{memberCount}</strong> member{memberCount === 1 ? '' : 's'}
                </span>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => openMatrix(role)}
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: '0.8rem' }}
                  >
                    Permissions
                  </button>
                  {!isSystem && (
                    <>
                      <button
                        onClick={() => openEditRole(role)}
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: '0.8rem' }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => onDeleteRole(role)}
                        className="btn btn-ghost btn-sm"
                        disabled={memberCount > 0}
                        title={memberCount > 0 ? 'Cannot delete role assigned to members' : 'Delete custom role'}
                        style={{
                          fontSize: '0.8rem',
                          color: memberCount > 0 ? 'var(--text-disabled)' : 'var(--color-error-400)',
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Role Create/Edit Modal */}
      <AnimatePresence>
        {modalOpen && (
          <>
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'hsla(220, 50%, 5%, 0.7)',
                backdropFilter: 'blur(4px)',
                zIndex: 200,
              }}
              onClick={() => setModalOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.96 }}
              style={{
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '100%',
                maxWidth: '460px',
                zIndex: 201,
              }}
            >
              <div className="glass-card" style={{ padding: '28px' }}>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px' }}>
                  {editingRole ? 'Edit Custom Role' : 'New Custom Role'}
                </h3>

                <form onSubmit={handleSubmit(onSaveRole)}>
                  <div style={{ marginBottom: '16px' }}>
                    <label
                      style={{
                        display: 'block',
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        color: 'var(--text-secondary)',
                        marginBottom: '6px',
                      }}
                    >
                      Role Name
                    </label>
                    <input
                      type="text"
                      className="input"
                      placeholder="e.g. Compliance Officer, Lead Auditor"
                      required
                      {...register('name')}
                    />
                  </div>

                  <div style={{ marginBottom: '24px' }}>
                    <label
                      style={{
                        display: 'block',
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        color: 'var(--text-secondary)',
                        marginBottom: '6px',
                      }}
                    >
                      Description
                    </label>
                    <textarea
                      className="input"
                      rows={3}
                      placeholder="Briefly explain what this role can do..."
                      {...register('description')}
                    />
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
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
                      disabled={createRole.isPending || updateRole.isPending}
                    >
                      Save Role
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Permission Matrix Modal */}
      <AnimatePresence>
        {matrixOpen && activeRoleForMatrix && (
          <>
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'hsla(220, 50%, 5%, 0.7)',
                backdropFilter: 'blur(4px)',
                zIndex: 200,
              }}
              onClick={() => setMatrixOpen(false)}
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
                width: '100%',
                maxWidth: '720px',
                maxHeight: '85vh',
                display: 'flex',
                flexDirection: 'column',
                zIndex: 201,
              }}
            >
              <div
                className="glass-card"
                style={{
                  padding: '28px',
                  display: 'flex',
                  flexDirection: 'column',
                  maxHeight: '85vh',
                  overflow: 'hidden',
                }}
              >
                {/* Header */}
                <div style={{ marginBottom: '20px', flexShrink: 0 }}>
                  <h3 style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                    Permissions Matrix —{' '}
                    <span className="gradient-text">{activeRoleForMatrix.name}</span>
                  </h3>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    Select specific granular permissions for this role.
                  </p>
                </div>

                {/* Matrix Body */}
                <div style={{ flex: 1, overflowY: 'auto', paddingRight: '6px', marginBottom: '20px' }}>
                  {Object.entries(categories).map(([category, codes]) => {
                    const allSelected = codes.every((code) => selectedPerms.includes(code));
                    return (
                      <div
                        key={category}
                        style={{
                          marginBottom: '20px',
                          background: 'var(--bg-overlay)',
                          borderRadius: 'var(--radius-md)',
                          padding: '16px',
                          border: '1px solid var(--border-subtle)',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginBottom: '12px',
                            borderBottom: '1px solid var(--border-subtle)',
                            paddingBottom: '8px',
                          }}
                        >
                          <span
                            style={{
                              fontSize: '0.85rem',
                              fontWeight: 700,
                              color: 'var(--text-primary)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                            }}
                          >
                            📁 {category}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleCategory(codes)}
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: '0.75rem', color: 'var(--color-primary-400)' }}
                          >
                            {allSelected ? 'Deselect All' : 'Select All'}
                          </button>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
                          {codes.map((code) => {
                            const entry = catalog?.permissions.find((p) => p.code === code);
                            const checked = selectedPerms.includes(code);
                            return (
                              <label
                                key={code}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '10px',
                                  padding: '8px 10px',
                                  borderRadius: 'var(--radius-sm)',
                                  background: checked ? 'hsla(217, 100%, 50%, 0.12)' : 'transparent',
                                  border: `1px solid ${checked ? 'hsla(217, 100%, 50%, 0.25)' : 'transparent'}`,
                                  cursor: 'pointer',
                                  transition: 'all var(--transition-fast)',
                                  userSelect: 'none',
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => togglePermission(code)}
                                  style={{ cursor: 'pointer' }}
                                />
                                <div>
                                  <div style={{ fontSize: '0.82rem', fontWeight: 600, color: checked ? 'var(--color-primary-300)' : 'var(--text-primary)' }}>
                                    {code}
                                  </div>
                                  {entry?.description && (
                                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                      {entry.description}
                                    </div>
                                  )}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Footer */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderTop: '1px solid var(--border-subtle)',
                    paddingTop: '16px',
                    flexShrink: 0,
                  }}
                >
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    <strong>{selectedPerms.length}</strong> of{' '}
                    {catalog?.permissions.length || 0} permissions selected
                  </span>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setMatrixOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={savePermissionsMatrix}
                      disabled={setRolePermissions.isPending}
                    >
                      Save Permissions
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
