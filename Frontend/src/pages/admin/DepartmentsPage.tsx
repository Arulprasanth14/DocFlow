/**
 * DocFlow Frontend — Admin: Departments & Teams Page
 * Collapsible tree of departments with inline actions and team assignments.
 */

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { motion, AnimatePresence } from 'framer-motion';
import {
  useDepartments,
  useTeams,
  useCreateDepartment,
  useUpdateDepartment,
  useDeleteDepartment,
  useCreateTeam,
  useDeleteTeam,
} from '@/hooks/useOrg';
import type { Department, Team } from '@/types';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

// ── Modals / Forms ─────────────────────────────────────────────────────────────
interface DeptFormData {
  name: string;
  code: string;
  parent_id: string;
}

interface TeamFormData {
  name: string;
  dept_id: string;
}

// ── Tree Node Component ────────────────────────────────────────────────────────
function DeptTreeNode({
  dept,
  allTeams,
  onAddSub,
  onEdit,
  onDelete,
}: {
  dept: Department;
  allTeams: Team[];
  onAddSub: (parent: Department) => void;
  onEdit: (dept: Department) => void;
  onDelete: (id: string, name: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const deptTeams = allTeams.filter((t) => t.dept_id === dept.id);
  const hasChildren = dept.children && dept.children.length > 0;

  return (
    <div style={{ marginLeft: dept.parent_id ? '24px' : '0', marginBottom: '8px' }}>
      <div
        className="glass-card"
        style={{
          padding: '14px 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderLeft: '4px solid var(--color-primary-500)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {hasChildren && (
            <button
              onClick={() => setExpanded(!expanded)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                padding: '2px',
                display: 'flex',
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{
                  transform: expanded ? 'rotate(90deg)' : 'none',
                  transition: 'transform var(--transition-fast)',
                }}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                {dept.name}
              </span>
              {dept.code && (
                <span
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    color: 'var(--text-muted)',
                    background: 'var(--bg-overlay)',
                    padding: '2px 6px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  {dept.code}
                </span>
              )}
            </div>
            {deptTeams.length > 0 && (
              <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
                {deptTeams.map((t) => (
                  <span
                    key={t.id}
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--color-primary-300)',
                      background: 'hsla(217, 100%, 50%, 0.1)',
                      border: '1px solid hsla(217, 100%, 50%, 0.2)',
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-full)',
                    }}
                  >
                    👥 {t.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => onAddSub(dept)}
            className="btn btn-ghost btn-sm"
            title="Add Sub-department"
            style={{ fontSize: '0.8rem' }}
          >
            + Sub-dept
          </button>
          <button
            onClick={() => onEdit(dept)}
            className="btn btn-ghost btn-sm"
            style={{ fontSize: '0.8rem' }}
          >
            Edit
          </button>
          <button
            onClick={() => onDelete(dept.id, dept.name)}
            className="btn btn-ghost btn-sm"
            style={{ fontSize: '0.8rem', color: 'var(--color-error-400)' }}
          >
            Delete
          </button>
        </div>
      </div>

      <AnimatePresence>
        {expanded && hasChildren && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{ overflow: 'hidden', marginTop: '8px' }}
          >
            {dept.children!.map((child) => (
              <DeptTreeNode
                key={child.id}
                dept={child}
                allTeams={allTeams}
                onAddSub={onAddSub}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function DepartmentsPage() {
  const { data: treeDepts = [], isLoading: deptsLoading } = useDepartments(false);
  const { data: flatDepts = [] } = useDepartments(true);
  const { data: teams = [], isLoading: teamsLoading } = useTeams();

  const createDept = useCreateDepartment();
  const updateDept = useUpdateDepartment();
  const deleteDept = useDeleteDepartment();
  const createTeam = useCreateTeam();
  const deleteTeam = useDeleteTeam();

  const [deptModalOpen, setDeptModalOpen] = useState(false);
  const [editingDept, setEditingDept] = useState<Department | null>(null);
  const [parentDeptForNew, setParentDeptForNew] = useState<Department | null>(null);

  const [teamModalOpen, setTeamModalOpen] = useState(false);

  const [deptError, setDeptError] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{ type: 'dept' | 'team', id: string, title: string } | null>(null);

  const { register: registerDept, handleSubmit: handleDeptSubmit, reset: resetDept } =
    useForm<DeptFormData>();
  const { register: registerTeam, handleSubmit: handleTeamSubmit, reset: resetTeam } =
    useForm<TeamFormData>();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDeptModalOpen(false);
        setTeamModalOpen(false);
        setConfirmState(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const openNewDept = (parent?: Department) => {
    setEditingDept(null);
    setParentDeptForNew(parent || null);
    setDeptError(null);
    resetDept({
      name: '',
      code: '',
      parent_id: parent ? parent.id : '',
    });
    setDeptModalOpen(true);
  };

  const openEditDept = (dept: Department) => {
    setEditingDept(dept);
    setParentDeptForNew(null);
    setDeptError(null);
    resetDept({
      name: dept.name,
      code: dept.code || '',
      parent_id: dept.parent_id || '',
    });
    setDeptModalOpen(true);
  };

  const onDeptSave = async (data: DeptFormData) => {
    try {
      if (editingDept) {
        await updateDept.mutateAsync({
          id: editingDept.id,
          data: {
            name: data.name,
            code: data.code || undefined,
            parent_id: data.parent_id || null,
          },
        });
      } else {
        await createDept.mutateAsync({
          name: data.name,
          code: data.code || undefined,
          parent_id: data.parent_id || null,
        });
      }
      setDeptModalOpen(false);
    } catch (e: any) {
      setDeptError(e.message || 'Failed to save department');
    }
  };

  const onDeptDelete = (id: string, name: string) => {
    setConfirmState({ type: 'dept', id, title: name });
  };

  const openNewTeam = () => {
    setTeamError(null);
    resetTeam({ name: '', dept_id: '' });
    setTeamModalOpen(true);
  };

  const onTeamSave = async (data: TeamFormData) => {
    try {
      await createTeam.mutateAsync({
        name: data.name,
        dept_id: data.dept_id || null,
      });
      setTeamModalOpen(false);
    } catch (e: any) {
      setTeamError(e.message || 'Failed to save team');
    }
  };

  const onTeamDelete = (id: string, name: string) => {
    setConfirmState({ type: 'team', id, title: name });
  };

  const executeDelete = async () => {
    if (!confirmState) return;
    try {
      if (confirmState.type === 'dept') {
        await deleteDept.mutateAsync(confirmState.id);
      } else {
        await deleteTeam.mutateAsync(confirmState.id);
      }
    } finally {
      setConfirmState(null);
    }
  };

  if (deptsLoading || teamsLoading) {
    return (
      <div style={{ padding: '40px', display: 'flex', justifyContent: 'center' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

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
            Departments & Teams
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
            Configure organizational hierarchy and assign squads for document workflows.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={() => openNewDept()} className="btn btn-primary">
            + New Department
          </button>
          <button onClick={() => openNewTeam()} className="btn btn-secondary">
            + New Team
          </button>
        </div>
      </div>

      {/* Grid Layout: Dept Tree (left) + Teams List (right) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '32px' }}>
        {/* Department Hierarchy */}
        <div>
          <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px' }}>
            Department Hierarchy
          </h2>
          {treeDepts.length === 0 ? (
            <div
              className="glass-card"
              style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}
            >
              No departments created yet. Click "+ New Department" to get started.
            </div>
          ) : (
            <div>
              {treeDepts.map((root) => (
                <DeptTreeNode
                  key={root.id}
                  dept={root}
                  allTeams={teams}
                  onAddSub={openNewDept}
                  onEdit={openEditDept}
                  onDelete={onDeptDelete}
                />
              ))}
            </div>
          )}
        </div>

        {/* Teams List */}
        <div>
          <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px' }}>
            All Teams
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: '16px',
            }}
          >
            {teams.map((team) => {
              const dept = flatDepts.find((d) => d.id === team.dept_id);
              return (
                <motion.div
                  key={team.id}
                  className="glass-card"
                  style={{
                    padding: '16px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                  whileHover={{ y: -2 }}
                >
                  <div>
                    <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
                      {team.name}
                    </h3>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      {dept ? `Dept: ${dept.name}` : 'Unassigned'}
                    </p>
                  </div>
                  <button
                    onClick={() => onTeamDelete(team.id, team.name)}
                    className="btn btn-ghost btn-sm"
                    style={{ color: 'var(--color-error-400)' }}
                  >
                    Delete
                  </button>
                </motion.div>
              );
            })}
            {teams.length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                No teams created yet.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Dept Modal */}
      <AnimatePresence>
        {deptModalOpen && (
          <>
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'hsla(220, 50%, 5%, 0.7)',
                backdropFilter: 'blur(4px)',
                zIndex: 200,
              }}
              onClick={() => setDeptModalOpen(false)}
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
              <div className="glass-card" style={{ padding: '28px' }} role="dialog" aria-modal="true" aria-labelledby="dept-modal-title">
                <h3 id="dept-modal-title" style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px' }}>
                  {editingDept
                    ? 'Edit Department'
                    : parentDeptForNew
                    ? `Add Sub-department to ${parentDeptForNew.name}`
                    : 'New Department'}
                </h3>
                
                <AnimatePresence>
                  {deptError && (
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
                      {deptError}
                    </motion.div>
                  )}
                </AnimatePresence>

                <form onSubmit={handleDeptSubmit(onDeptSave)}>
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
                      Department Name
                    </label>
                    <input
                      type="text"
                      className="input"
                      placeholder="e.g. Legal, Finance, Engineering"
                      required
                      {...registerDept('name')}
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
                      Department Code (Optional)
                    </label>
                    <input
                      type="text"
                      className="input"
                      placeholder="e.g. LEG, FIN, ENG"
                      {...registerDept('code')}
                    />
                  </div>

                  {!parentDeptForNew && (
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
                        Parent Department (Optional)
                      </label>
                      <select className="input" {...registerDept('parent_id')}>
                        <option value="">— Top-level Department —</option>
                        {flatDepts
                          .filter((d) => !editingDept || d.id !== editingDept.id)
                          .map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                      </select>
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setDeptModalOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={createDept.isPending || updateDept.isPending}
                    >
                      Save Department
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Team Modal */}
      <AnimatePresence>
        {teamModalOpen && (
          <>
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'hsla(220, 50%, 5%, 0.7)',
                backdropFilter: 'blur(4px)',
                zIndex: 200,
              }}
              onClick={() => setTeamModalOpen(false)}
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
              <div className="glass-card" style={{ padding: '28px' }} role="dialog" aria-modal="true" aria-labelledby="team-modal-title">
                <h3 id="team-modal-title" style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px' }}>
                  New Team
                </h3>

                <AnimatePresence>
                  {teamError && (
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
                      {teamError}
                    </motion.div>
                  )}
                </AnimatePresence>

                <form onSubmit={handleTeamSubmit(onTeamSave)}>
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
                      Team Name
                    </label>
                    <input
                      type="text"
                      className="input"
                      placeholder="e.g. Core Services, QA, Security"
                      required
                      {...registerTeam('name')}
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
                      Assign to Department (Optional)
                    </label>
                    <select className="input" {...registerTeam('dept_id')}>
                      <option value="">— Unassigned —</option>
                      {flatDepts.map((d) => (
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
                      onClick={() => setTeamModalOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={createTeam.isPending}
                    >
                      Create Team
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
        title={confirmState?.type === 'dept' ? 'Delete Department' : 'Delete Team'}
        message={`Are you sure you want to delete "${confirmState?.title}"? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={executeDelete}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}
