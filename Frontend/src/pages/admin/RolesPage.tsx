/**
 * DocFlow Frontend — Admin: Roles & Permissions Page
 *
 * Read-only view of DocFlow's 4 fixed org roles (Main Admin / HR / Worker /
 * Trainee) and their permission sets. There is no custom-role builder —
 * every org gets exactly these 4 roles, seeded identically by the backend
 * (domain/enums.py::SYSTEM_ROLES), and role assignment happens per-member
 * on the Members page. This intentionally removes the previous
 * create/edit/delete-role and permission-matrix-editing UI, since DocFlow's
 * RBAC model doesn't support a 5th role or a custom permission mix.
 *
 * Main-Administrator-only: routed behind `requireRole={['admin']}` in
 * App.tsx per requirements §13.4 — HR's day-to-day admin access does not
 * extend to viewing/managing roles.
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRoles, usePermissions } from '@/hooks/useOrg';
import type { Role } from '@/types';

const ROLE_ORDER = ['admin', 'hr', 'worker', 'trainee'];

export default function RolesPage() {
  const { data: roles = [], isLoading: rolesLoading } = useRoles();
  const { data: catalog, isLoading: permsLoading } = usePermissions();

  const [matrixOpen, setMatrixOpen] = useState(false);
  const [activeRole, setActiveRole] = useState<Role | null>(null);

  const openMatrix = (role: Role) => {
    setActiveRole(role);
    setMatrixOpen(true);
  };

  if (rolesLoading || permsLoading) {
    return (
      <div style={{ padding: '40px', display: 'flex', justifyContent: 'center' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  const categories = catalog?.by_category || {};
  const sortedRoles = [...roles].sort(
    (a, b) => ROLE_ORDER.indexOf(a.name) - ROLE_ORDER.indexOf(b.name),
  );

  return (
    <div style={{ padding: '32px', maxWidth: '1100px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: '32px' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>
          Roles & Permissions
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
          DocFlow has 3 fixed roles — Admin, Worker, and Trainee. Assign a role to each
          member from the Members page; permissions here are fixed per role and cannot
          be customized.
        </p>
      </div>

      {/* Role Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: '20px',
        }}
      >
        {sortedRoles.map((role, idx) => {
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
                borderTop: '2px solid var(--color-accent-500)',
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <h3 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)', textTransform: 'capitalize' }}>
                    {role.name}
                  </h3>
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
                    🔒 Fixed Role
                  </span>
                </div>

                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '16px', minHeight: '36px' }}>
                  {role.description || 'No description provided.'}
                </p>

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
                <button
                  onClick={() => openMatrix(role)}
                  className="btn btn-secondary btn-sm"
                  style={{ fontSize: '0.8rem' }}
                >
                  View Permissions
                </button>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Permissions Viewer Modal (read-only) */}
      <AnimatePresence>
        {matrixOpen && activeRole && (
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
                <div style={{ marginBottom: '20px', flexShrink: 0 }}>
                  <h3 style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--text-primary)', textTransform: 'capitalize' }}>
                    Permissions —{' '}
                    <span className="gradient-text">{activeRole.name}</span>
                  </h3>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    Fixed for this role — not editable.
                  </p>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', paddingRight: '6px' }}>
                  {Object.entries(categories).map(([category, codes]) => {
                    const granted = codes.filter((c) => (activeRole.permissions || []).includes(c));
                    if (granted.length === 0) return null;
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
                            fontSize: '0.85rem',
                            fontWeight: 700,
                            color: 'var(--text-primary)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.04em',
                            marginBottom: '12px',
                            borderBottom: '1px solid var(--border-subtle)',
                            paddingBottom: '8px',
                          }}
                        >
                          📁 {category}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
                          {granted.map((code) => {
                            const entry = catalog?.permissions.find((p) => p.code === code);
                            return (
                              <div
                                key={code}
                                style={{
                                  padding: '8px 10px',
                                  borderRadius: 'var(--radius-sm)',
                                  background: 'hsla(217, 100%, 50%, 0.12)',
                                  border: '1px solid hsla(217, 100%, 50%, 0.25)',
                                }}
                              >
                                <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--color-primary-300)' }}>
                                  {code}
                                </div>
                                {entry?.description && (
                                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                    {entry.description}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    borderTop: '1px solid var(--border-subtle)',
                    paddingTop: '16px',
                    flexShrink: 0,
                  }}
                >
                  <button type="button" className="btn btn-secondary" onClick={() => setMatrixOpen(false)}>
                    Close
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
