/**
 * DocFlow Frontend — Admin: Members & User Management Page
 * Searchable, paginated member table with invite flow and role/department re-assignment.
 */

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { motion, AnimatePresence } from 'framer-motion';
import {
  useMembers,
  useRoles,
  useDepartments,
  useInviteMember,
  useUpdateMember,
  useRemoveMember,
} from '@/hooks/useOrg';
import type { MemberDetail } from '@/types';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

interface InviteFormData {
  email: string;
  name: string;
  role_id: string;
  dept_id: string;
}

interface EditMemberFormData {
  role_id: string;
  dept_id: string;
  status: string;
}

export default function MembersPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');

  const { data: membersData, isLoading: membersLoading } = useMembers({
    page,
    limit: 10,
    search: search || undefined,
    role_id: roleFilter || undefined,
    dept_id: deptFilter || undefined,
  });

  const { data: roles = [] } = useRoles();
  const { data: depts = [] } = useDepartments(true);

  const inviteMember = useInviteMember();
  const updateMember = useUpdateMember();
  const removeMember = useRemoveMember();

  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<MemberDetail | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{ id: string; email: string } | null>(null);

  const {
    register: registerInvite,
    handleSubmit: handleInviteSubmit,
    reset: resetInvite,
  } = useForm<InviteFormData>();

  const {
    register: registerEdit,
    handleSubmit: handleEditSubmit,
    reset: resetEdit,
  } = useForm<EditMemberFormData>();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setInviteModalOpen(false);
        setEditModalOpen(false);
        setConfirmState(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const openInviteModal = () => {
    setInviteError(null);
    resetInvite({
      email: '',
      name: '',
      role_id: roles[0]?.id || '',
      dept_id: '',
    });
    setInviteModalOpen(true);
  };

  const onInviteSave = async (data: InviteFormData) => {
    try {
      await inviteMember.mutateAsync({
        email: data.email,
        name: data.name || undefined,
        role_id: data.role_id,
        dept_id: data.dept_id || null,
      });
      setInviteModalOpen(false);
      setSuccessMsg(`Invited ${data.email} successfully.`);
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (e: any) {
      setInviteError(e.message || 'Failed to send invitation');
    }
  };

  const openEditModal = (member: MemberDetail) => {
    setSelectedMember(member);
    setEditError(null);
    resetEdit({
      role_id: member.role_id,
      dept_id: member.dept_id || '',
      status: member.status,
    });
    setEditModalOpen(true);
  };

  const onEditSave = async (data: EditMemberFormData) => {
    if (!selectedMember) return;
    try {
      await updateMember.mutateAsync({
        id: selectedMember.id,
        data: {
          role_id: data.role_id,
          dept_id: data.dept_id || null,
          status: data.status,
        },
      });
      setEditModalOpen(false);
    } catch (e: any) {
      setEditError(e.message || 'Failed to update member');
    }
  };

  const onRemoveMember = (member: MemberDetail) => {
    const email = member.user?.email || 'this member';
    setConfirmState({ id: member.id, email });
  };

  const executeRemove = async () => {
    if (!confirmState) return;
    try {
      await removeMember.mutateAsync(confirmState.id);
    } finally {
      setConfirmState(null);
    }
  };

  const items = membersData?.items || [];
  const totalPages = membersData?.pages || 1;

  return (
    <div style={{ padding: '32px', maxWidth: '1150px', margin: '0 auto' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '28px',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>
            Organization Members
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
            Invite teammates, assign organizational roles, and manage workspace access.
          </p>
        </div>
        <button onClick={openInviteModal} className="btn btn-primary">
          + Invite Member
        </button>
      </div>

      <AnimatePresence>
        {successMsg && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            style={{
              marginBottom: '20px',
              padding: '12px 16px',
              borderRadius: 'var(--radius-md)',
              background: 'hsla(145, 70%, 45%, 0.1)',
              border: '1px solid hsla(145, 70%, 45%, 0.25)',
              color: 'var(--color-success-400)',
              fontSize: '0.875rem',
            }}
          >
            ✓ {successMsg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Filter Toolbar */}
      <div
        className="glass-card"
        style={{
          padding: '16px 20px',
          marginBottom: '24px',
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
          flexWrap: 'wrap',
        }}
      >
        {/* Search Input */}
        <div style={{ flex: '1 1 240px' }}>
          <input
            type="text"
            className="input"
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>

        {/* Role Filter */}
        <div style={{ flex: '0 1 200px' }}>
          <select
            className="input"
            value={roleFilter}
            onChange={(e) => {
              setRoleFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All Roles</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        {/* Dept Filter */}
        <div style={{ flex: '0 1 200px' }}>
          <select
            className="input"
            value={deptFilter}
            onChange={(e) => {
              setDeptFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All Departments</option>
            {depts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>

        {(search || roleFilter || deptFilter) && (
          <button
            onClick={() => {
              setSearch('');
              setRoleFilter('');
              setDeptFilter('');
              setPage(1);
            }}
            className="btn btn-ghost btn-sm"
          >
            Clear Filters
          </button>
        )}
      </div>

      {/* Members Table */}
      <div className="glass-card" style={{ overflow: 'hidden' }}>
        {membersLoading ? (
          <div style={{ padding: '60px', display: 'flex', justifyContent: 'center' }}>
            <div className="spinner" style={{ width: '32px', height: '32px' }} />
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
            No members found matching your filters.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ background: 'var(--bg-overlay)', borderBottom: '1px solid var(--border-subtle)' }}>
                  <th style={{ padding: '14px 20px', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    User
                  </th>
                  <th style={{ padding: '14px 20px', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    Role
                  </th>
                  <th style={{ padding: '14px 20px', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    Department
                  </th>
                  <th style={{ padding: '14px 20px', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    Status
                  </th>
                  <th style={{ padding: '14px 20px', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    Joined
                  </th>
                  <th style={{ padding: '14px 20px', textAlign: 'right', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((member) => {
                  const u = member.user;
                  const r = member.role;
                  const dept = depts.find((d) => d.id === member.dept_id);
                  const initials = u?.name
                    ? u.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
                    : u?.email?.[0]?.toUpperCase() || '?';

                  return (
                    <tr
                      key={member.id}
                      style={{
                        borderBottom: '1px solid var(--border-subtle)',
                        transition: 'background var(--transition-fast)',
                      }}
                    >
                      {/* User Column */}
                      <td style={{ padding: '16px 20px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          {u?.avatar_url ? (
                            <img
                              src={u.avatar_url}
                              alt=""
                              style={{ width: '38px', height: '38px', borderRadius: '50%', objectFit: 'cover' }}
                            />
                          ) : (
                            <div
                              style={{
                                width: '38px',
                                height: '38px',
                                borderRadius: '50%',
                                background: 'linear-gradient(135deg, var(--color-primary-500), var(--color-accent-500))',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontWeight: 700,
                                fontSize: '0.9rem',
                                color: 'white',
                              }}
                            >
                              {initials}
                            </div>
                          )}
                          <div>
                            <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.95rem' }}>
                              {u?.name || u?.email || 'Unknown User'}
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                              {u?.email || ''}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Role Column */}
                      <td style={{ padding: '16px 20px' }}>
                        <span
                          style={{
                            fontSize: '0.78rem',
                            fontWeight: 600,
                            color: 'var(--color-primary-300)',
                            background: 'hsla(217, 100%, 50%, 0.12)',
                            border: '1px solid hsla(217, 100%, 50%, 0.25)',
                            padding: '3px 10px',
                            borderRadius: 'var(--radius-full)',
                          }}
                        >
                          {r?.name || 'No Role'}
                        </span>
                      </td>

                      {/* Dept Column */}
                      <td style={{ padding: '16px 20px' }}>
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          {dept?.name || '—'}
                        </span>
                      </td>

                      {/* Status Column */}
                      <td style={{ padding: '16px 20px' }}>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            padding: '3px 10px',
                            borderRadius: 'var(--radius-full)',
                            background:
                              member.status === 'active'
                                ? 'hsla(145, 70%, 50%, 0.12)'
                                : 'hsla(38, 92%, 50%, 0.12)',
                            color:
                              member.status === 'active'
                                ? 'var(--color-success-400)'
                                : 'var(--color-warning-400)',
                          }}
                        >
                          {member.status.toUpperCase()}
                        </span>
                      </td>

                      {/* Joined Date */}
                      <td style={{ padding: '16px 20px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                        {member.joined_at ? new Date(member.joined_at).toLocaleDateString() : '—'}
                      </td>

                      {/* Actions */}
                      <td style={{ padding: '16px 20px', textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '8px' }}>
                          <button
                            onClick={() => openEditModal(member)}
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: '0.8rem' }}
                          >
                            Edit Role/Dept
                          </button>
                          <button
                            onClick={() => onRemoveMember(member)}
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: '0.8rem', color: 'var(--color-error-400)' }}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        {totalPages > 1 && (
          <div
            style={{
              padding: '16px 24px',
              borderTop: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Page <strong>{page}</strong> of <strong>{totalPages}</strong>
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                className="btn btn-secondary btn-sm"
              >
                Previous
              </button>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
                className="btn btn-secondary btn-sm"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Invite Member Modal */}
      <AnimatePresence>
        {inviteModalOpen && (
          <>
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'hsla(220, 50%, 5%, 0.7)',
                backdropFilter: 'blur(4px)',
                zIndex: 200,
              }}
              onClick={() => setInviteModalOpen(false)}
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
              <div className="glass-card" style={{ padding: '28px' }} role="dialog" aria-modal="true" aria-labelledby="invite-modal-title">
                <h3 id="invite-modal-title" style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px' }}>
                  Invite New Member
                </h3>
                
                <AnimatePresence>
                  {inviteError && (
                    <motion.div
                      initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                      animate={{ opacity: 1, height: 'auto', marginBottom: 16 }}
                      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                      style={{
                        padding: '12px 16px',
                        borderRadius: 'var(--radius-md)',
                        background: 'hsla(0, 82%, 55%, 0.1)',
                        border: '1px solid hsla(0, 82%, 55%, 0.25)',
                        color: 'var(--color-error-400)',
                        fontSize: '0.875rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        overflow: 'hidden',
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                      </svg>
                      {inviteError}
                    </motion.div>
                  )}
                </AnimatePresence>

                <form onSubmit={handleInviteSubmit(onInviteSave)}>
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
                      Email Address
                    </label>
                    <input
                      type="email"
                      className="input"
                      placeholder="colleague@company.com"
                      required
                      {...registerInvite('email')}
                    />
                  </div>

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
                      Full Name (Optional)
                    </label>
                    <input
                      type="text"
                      className="input"
                      placeholder="Jane Doe"
                      {...registerInvite('name')}
                    />
                  </div>

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
                      Role
                    </label>
                    <select className="input" required {...registerInvite('role_id')}>
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} {r.is_system ? '(System)' : ''}
                        </option>
                      ))}
                    </select>
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
                      Department (Optional)
                    </label>
                    <select className="input" {...registerInvite('dept_id')}>
                      <option value="">— No Department —</option>
                      {depts.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setInviteModalOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={inviteMember.isPending}
                    >
                      Send Invitation
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Edit Member Modal */}
      <AnimatePresence>
        {editModalOpen && selectedMember && (
          <>
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'hsla(220, 50%, 5%, 0.7)',
                backdropFilter: 'blur(4px)',
                zIndex: 200,
              }}
              onClick={() => setEditModalOpen(false)}
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
              <div className="glass-card" style={{ padding: '28px' }} role="dialog" aria-modal="true" aria-labelledby="edit-modal-title">
                <h3 id="edit-modal-title" style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
                  Edit Member Access
                </h3>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
                  {selectedMember.user?.name || selectedMember.user?.email}
                </p>

                <AnimatePresence>
                  {editError && (
                    <motion.div
                      initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                      animate={{ opacity: 1, height: 'auto', marginBottom: 16 }}
                      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                      style={{
                        padding: '12px 16px',
                        borderRadius: 'var(--radius-md)',
                        background: 'hsla(0, 82%, 55%, 0.1)',
                        border: '1px solid hsla(0, 82%, 55%, 0.25)',
                        color: 'var(--color-error-400)',
                        fontSize: '0.875rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        overflow: 'hidden',
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                      </svg>
                      {editError}
                    </motion.div>
                  )}
                </AnimatePresence>

                <form onSubmit={handleEditSubmit(onEditSave)}>
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
                      Assigned Role
                    </label>
                    <select className="input" required {...registerEdit('role_id')}>
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} {r.is_system ? '(System)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>

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
                      Department
                    </label>
                    <select className="input" {...registerEdit('dept_id')}>
                      <option value="">— No Department —</option>
                      {depts.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
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
                      Account Status
                    </label>
                    <select className="input" {...registerEdit('status')}>
                      <option value="active">Active</option>
                      <option value="suspended">Suspended</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setEditModalOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={updateMember.isPending}
                    >
                      Save Changes
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={confirmState !== null}
        title="Remove Member"
        message={`Are you sure you want to remove ${confirmState?.email} from the organization?`}
        confirmLabel="Remove"
        onConfirm={executeRemove}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}
