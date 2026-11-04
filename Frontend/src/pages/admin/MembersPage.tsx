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
import { useAuthStore } from '@/store/authStore';
import { useQueryClient } from '@tanstack/react-query';
import { orgsApi } from '@/lib/api/orgs';

interface InviteFormData {
  email: string;
  name: string;
  role_id: string;
  dept_id: string;
  password: string;
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
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
  const [statusFilter, setStatusFilter] = useState('');

  const { data: membersData, isLoading: membersLoading } = useMembers({
    page,
    limit: 10,
    search: search || undefined,
    role_id: roleFilter || undefined,
    dept_id: deptFilter || undefined,
    status: statusFilter || undefined,
  });

  const { data: roles = [] } = useRoles();
  const { data: depts = [] } = useDepartments(true);

  // §2.1/2.2/13.3: the Main Administrator can add Worker, Trainee, or HR;
  // HR can add only Worker/Trainee and can never delete a member or touch
  // an HR/Main-Admin member's role. Backend (org_service.py) enforces this
  // regardless of what the UI shows — this filtering is for usability, not
  // the authorization boundary itself.
  const hasRole = useAuthStore((s) => s.hasRole);
  const isMainAdmin = useAuthStore((s) => s.user?.is_superadmin) || hasRole('admin');
  const assignableRoles = roles.filter((r) => r.name !== 'admin' && (isMainAdmin || r.name !== 'hr'));

  const inviteMember = useInviteMember();
  const updateMember = useUpdateMember();
  const removeMember = useRemoveMember();

  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<MemberDetail | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [newCredentials, setNewCredentials] = useState<{ email: string; password: string } | null>(null);

  const [inviteError, setInviteError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{ id: string; email: string } | null>(null);

  const {
    register: registerInvite,
    handleSubmit: handleInviteSubmit,
    reset: resetInvite,
    setValue: setInviteValue,
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
      role_id: assignableRoles[0]?.id || '',
      dept_id: '',
      password: generatePassword(),
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
        password: data.password,
      });
      setInviteModalOpen(false);
      // There's no email-sending infrastructure for an invite link — these
      // are the only credentials the new member will ever see, so show them
      // once here for the admin to copy and relay out of band.
      setNewCredentials({ email: data.email, password: data.password });
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

  const [approveError, setApproveError] = useState<string | null>(null);

  // Join requests: accepting REQUIRES choosing a role (and any one admin/HR
  // can decide - first decision wins, the server answers 409 to the rest).
  const [acceptFor, setAcceptFor] = useState<MemberDetail | null>(null);
  const [acceptRoleId, setAcceptRoleId] = useState('');
  const queryClient = useQueryClient();

  const refreshMembers = () => {
    queryClient.invalidateQueries({ queryKey: ['org', 'members'] });
    queryClient.invalidateQueries({ queryKey: ['members'] });
    queryClient.invalidateQueries({ queryKey: ['org'] });
  };

  // Roles an approver may hand out from a request: never Main Admin; HR only
  // if the reviewer is the Main Admin (the server enforces the same rule).
  const joinAssignableRoles = roles.filter(
    (r) => r.name === 'worker' || r.name === 'trainee' || (r.name === 'hr' && isMainAdmin),
  );

  const onApproveRequest = (member: MemberDetail) => {
    setApproveError(null);
    setAcceptFor(member);
    setAcceptRoleId(joinAssignableRoles.find((r) => r.name === 'worker')?.id ?? joinAssignableRoles[0]?.id ?? '');
  };

  const confirmAccept = async () => {
    if (!acceptFor || !acceptRoleId) return;
    const target = acceptFor;
    try {
      const res = await orgsApi.acceptJoinRequest(target.id, acceptRoleId);
      setSuccessMsg(`Admitted ${target.user?.email || 'request'} as ${res.role}. They've been emailed.`);
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (e: any) {
      // 409 = someone else already handled it; the message names who.
      setApproveError(e.message || 'Failed to accept request');
    } finally {
      setAcceptFor(null);
      refreshMembers();
    }
  };

  const onDenyRequest = async (member: MemberDetail) => {
    setApproveError(null);
    try {
      await orgsApi.rejectJoinRequest(member.id);
      setSuccessMsg(`Rejected ${member.user?.email || 'request'}. They've been emailed.`);
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (e: any) {
      setApproveError(e.message || 'Failed to reject request');
    } finally {
      refreshMembers();
    }
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
          <h1 data-page-title className="font-display" style={{ fontSize: 'clamp(1.75rem, 1.2rem + 2vw, 2.4rem)', fontWeight: 400, lineHeight: 1.1, color: 'var(--foreground)', marginBottom: '6px' }}>
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
              background: 'color-mix(in srgb, var(--status-approved) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--status-approved) 25%, transparent)',
              color: 'var(--color-success-400)',
              fontSize: '0.875rem',
            }}
          >
            ✓ {successMsg}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {approveError && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            style={{
              marginBottom: '20px', padding: '12px 16px', borderRadius: 'var(--radius-md)',
              background: 'color-mix(in srgb, var(--destructive) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--destructive) 25%, transparent)',
              color: 'var(--color-error-400)', fontSize: '0.875rem',
            }}
          >
            {approveError}
          </motion.div>
        )}
      </AnimatePresence>

      {/* New-member credentials — shown once, right after invite. The member
          gets a real email letting them know their account was created, but
          it deliberately never contains the password (never emailed in
          plaintext) — this is still the only place the admin sees it, to
          relay out of band. */}
      <AnimatePresence>
        {newCredentials && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            style={{
              marginBottom: '20px',
              padding: '16px 20px',
              borderRadius: 'var(--radius-md)',
              background: 'color-mix(in srgb, var(--primary) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--primary) 25%, transparent)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
              <div>
                <p style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.9rem', marginBottom: '6px' }}>
                  Member added — share these credentials with them
                </p>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '10px' }}>
                  There's no automatic invite email. Send this password to{' '}
                  {newCredentials.email} yourself (chat, in person, etc.) — it won't be shown again.
                </p>
                <div style={{ display: 'flex', gap: '16px', fontFamily: 'monospace', fontSize: '0.85rem' }}>
                  <span><strong>Email:</strong> {newCredentials.email}</span>
                  <span><strong>Password:</strong> {newCredentials.password}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(
                      `Email: ${newCredentials.email}\nPassword: ${newCredentials.password}`
                    ).catch(() => {});
                  }}
                >
                  Copy
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setNewCredentials(null)}>
                  Dismiss
                </button>
              </div>
            </div>
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

        {/* Status Filter */}
        <div style={{ flex: '0 1 200px' }}>
          <select
            className="input"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All Statuses</option>
            <option value="active">Active</option>
            <option value="pending">Pending Requests</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>

        {(search || roleFilter || deptFilter || statusFilter) && (
          <button
            onClick={() => {
              setSearch('');
              setRoleFilter('');
              setDeptFilter('');
              setStatusFilter('');
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
                  // HR cannot delete any member, or edit an HR/Main-Admin
                  // member's role (backend-enforced in org_service.py;
                  // hidden here too so HR isn't offered an action that
                  // will just 403).
                  const targetIsProtected = r?.name === 'admin' || r?.name === 'hr';
                  const canEditThisMember = isMainAdmin || !targetIsProtected;
                  const canRemoveThisMember = isMainAdmin;
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
                            background: 'color-mix(in srgb, var(--primary) 12%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--primary) 25%, transparent)',
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
                                ? 'color-mix(in srgb, var(--status-approved) 14%, transparent)'
                                : 'color-mix(in srgb, var(--status-pending) 14%, transparent)',
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
                          {member.status === 'pending' ? (
                            <>
                              <button
                                onClick={() => onApproveRequest(member)}
                                className="btn btn-ghost btn-sm"
                                style={{ fontSize: '0.8rem', color: 'var(--color-success-400)' }}
                                disabled={updateMember.isPending}
                              >
                                Approve
                              </button>
                              <button
                                onClick={() => onDenyRequest(member)}
                                className="btn btn-ghost btn-sm"
                                style={{ fontSize: '0.8rem', color: 'var(--color-error-400)' }}
                                disabled={removeMember.isPending}
                              >
                                Deny
                              </button>
                            </>
                          ) : (
                            <>
                              {canEditThisMember && (
                                <button
                                  onClick={() => openEditModal(member)}
                                  className="btn btn-ghost btn-sm"
                                  style={{ fontSize: '0.8rem' }}
                                >
                                  Edit Role/Dept
                                </button>
                              )}
                              {canRemoveThisMember && (
                                <button
                                  onClick={() => onRemoveMember(member)}
                                  className="btn btn-ghost btn-sm"
                                  style={{ fontSize: '0.8rem', color: 'var(--color-error-400)' }}
                                >
                                  Remove
                                </button>
                              )}
                            </>
                          )}
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
                background: 'var(--overlay-scrim)',
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
                        background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--destructive) 25%, transparent)',
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
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        color: 'var(--text-secondary)',
                        marginBottom: '6px',
                      }}
                    >
                      Initial Password
                      <button
                        type="button"
                        onClick={() => setInviteValue('password', generatePassword())}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: 'var(--color-primary-400)', fontSize: '0.75rem', fontWeight: 600, padding: 0,
                        }}
                      >
                        Generate new
                      </button>
                    </label>
                    <input
                      type="text"
                      className="input"
                      style={{ fontFamily: 'monospace' }}
                      required
                      minLength={8}
                      {...registerInvite('password')}
                    />
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '6px' }}>
                      They'll get an email letting them know their account is ready —
                      but it never includes the password, so you'll still need to
                      share this with them yourself.
                    </p>
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
                      {assignableRoles.map((r) => (
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
                background: 'var(--overlay-scrim)',
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
                        background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--destructive) 25%, transparent)',
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
                      {assignableRoles.map((r) => (
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
        open={!!acceptFor}
        title="Admit to organization"
        message={`Choose the role ${acceptFor?.user?.name || acceptFor?.user?.email || 'this person'} will have. They'll be emailed as soon as you confirm.`}
        confirmLabel="Admit"
        confirmDisabled={!acceptRoleId}
        onConfirm={confirmAccept}
        onCancel={() => setAcceptFor(null)}
      >
        <select
          className="input"
          value={acceptRoleId}
          onChange={(e) => setAcceptRoleId(e.target.value)}
          style={{ width: '100%' }}
        >
          {joinAssignableRoles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </ConfirmDialog>

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
