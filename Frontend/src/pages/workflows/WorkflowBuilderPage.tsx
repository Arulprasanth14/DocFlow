/**
 * DocFlow Frontend — Workflow builder (Workflow module §5.3–§5.6)
 *
 * A full page at /workflows/new and /workflows/:id/edit, not a modal: §5.3
 * calls for room for many stage cards plus the preview, and the preview step
 * (§5.6) needs the whole viewport to read as a timeline.
 *
 * Two steps, Build -> Preview, sharing ONE piece of form state (WF-BLD-02):
 * moving Build -> Preview -> Edit preserves every entered value, stage order
 * and expanded/collapsed state, because nothing is re-derived on the way back.
 *
 * Drag reorder is real (@dnd-kit) and always has a keyboard-and-pointer
 * equivalent: Move up / Move down buttons plus dnd-kit's keyboard sensor, with
 * aria-live announcements (WF-STG-07/08, UX-A11Y-04). The previous builder
 * rendered a drag handle that did nothing, which UX-INT-01 forbids.
 *
 * Validation is the server's (WF-STG-28); this mirrors only the cheap local
 * rules and renders the server's own message verbatim so the two cannot drift.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Clock,
  GripVertical,
  Info,
  Loader2,
  Lock,
  Plus,
  ShieldCheck,
  Trash2,
  User,
  Users,
} from 'lucide-react';

import { PageHeader } from '@/components/ui/PageHeader';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { Stepper } from '@/components/ui/Stepper';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import WorkflowPreview, { type PreviewStage } from '@/components/workflows/WorkflowPreview';
import { ApiClientError } from '@/lib/api/client';
import { useSaveWorkflow, useWorkflowDetail, useWorkflowVersions } from '@/hooks/useWorkflows';
import { useMembers, useDepartments } from '@/hooks/useOrg';
import type { WorkflowStageInput, WorkflowTemplateInput } from '@/lib/api/workflows';

const C = {
  card: 'var(--bg-elevated)',
  surface: 'var(--bg-surface)',
  overlay: 'var(--bg-overlay)',
  border: 'var(--border-default)',
  borderSubtle: 'var(--border-subtle)',
  primary: 'var(--color-primary-400)',
  success: 'var(--color-success-400)',
  warning: 'var(--color-warning-400)',
  danger: 'var(--color-error-400)',
  heading: 'var(--text-primary)',
  body: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
};

/** O-5 / WF-STG-03. The server enforces this too. */
const MAX_STAGES = 10;
const UNDO_MS = 6000;

type ApproverKind = 'specific_user' | 'submitter_manager';

/** Local editing shape. `key` is a stable React/dnd id that survives reorder. */
interface StageDraft {
  key: string;
  name: string;
  approverKind: ApproverKind;
  approverUserId: string;
  departmentId: string;
  dueValue: number;
  dueUnit: 'hours' | 'days';
  requireSigning: boolean;
  expanded: boolean;
}

let keySeq = 0;
const nextKey = () => `stage-${++keySeq}-${Date.now()}`;

function emptyStage(index: number): StageDraft {
  return {
    key: nextKey(),
    name: index === 0 ? 'Review' : '',
    approverKind: 'specific_user',
    approverUserId: '',
    departmentId: '',
    dueValue: 2,
    dueUnit: 'days',
    requireSigning: false,
    expanded: true,
  };
}

function hoursOf(s: StageDraft): number {
  return s.dueUnit === 'days' ? s.dueValue * 24 : s.dueValue;
}

// ── Stage card ───────────────────────────────────────────────────────────────

function StageCard({
  stage,
  index,
  total,
  people,
  departments,
  signingLockedDepts,
  onPatch,
  onRemove,
  onMove,
  problem,
}: {
  stage: StageDraft;
  index: number;
  total: number;
  people: { value: string; label: string; hint?: string }[];
  departments: { value: string; label: string }[];
  signingLockedDepts: Set<string>;
  onPatch: (patch: Partial<StageDraft>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  problem?: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: stage.key });

  // WF-STG-20: when the chosen department requires signing, the toggle is ON
  // and locked. The server forces the value regardless of what we send, so
  // this is honesty in the UI rather than the enforcement itself.
  const signingLocked = !!stage.departmentId && signingLockedDepts.has(stage.departmentId);
  const signingOn = signingLocked || stage.requireSigning;

  // WF-STG-09: a card with an error always expands so the problem is visible.
  const expanded = stage.expanded || !!problem;

  const summary = [
    stage.approverKind === 'submitter_manager'
      ? 'Submitter’s manager'
      : people.find((p) => p.value === stage.approverUserId)?.label || 'No approver',
    departments.find((d) => d.value === stage.departmentId)?.label,
    `${stage.dueValue} ${stage.dueUnit}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li
      ref={setNodeRef}
      style={{
        // Written out rather than importing @dnd-kit/utilities, which is only
        // a transitive dependency here. Sorting moves items on one axis, so
        // translate is all that is needed.
        transform: transform
          ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
          : undefined,
        transition,
        listStyle: 'none',
        // WF-STG-07: lifted shadow while dragging.
        boxShadow: isDragging ? 'var(--shadow-lg)' : 'none',
        borderRadius: 14,
        position: 'relative',
        zIndex: isDragging ? 5 : 'auto',
      }}
    >
      <div
        style={{
          background: C.card,
          border: `1px solid ${problem ? C.danger : C.border}`,
          borderRadius: 14,
          padding: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${stage.name || `stage ${index + 1}`}`}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'grab',
              color: C.muted,
              padding: 4,
              touchAction: 'none',
            }}
          >
            <GripVertical size={15} aria-hidden />
          </button>

          <span
            aria-hidden
            style={{
              fontSize: 10.5,
              fontWeight: 800,
              color: C.primary,
              background: `color-mix(in srgb, ${C.primary} 12%, transparent)`,
              border: `1px solid color-mix(in srgb, ${C.primary} 28%, transparent)`,
              borderRadius: 6,
              padding: '2px 7px',
              flexShrink: 0,
            }}
          >
            Step {index + 1}
          </span>

          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13.5,
              fontWeight: 700,
              color: C.heading,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {stage.name || 'Untitled stage'}
            {!expanded ? (
              <span style={{ fontWeight: 400, color: C.muted, fontSize: 12 }}>
                {' '}
                — {summary}
              </span>
            ) : null}
          </span>

          {/* WF-STG-08: accessible alternative to dragging, always present. */}
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            title="Move up"
            aria-label={`Move ${stage.name || `stage ${index + 1}`} up`}
            style={iconBtn(index === 0)}
          >
            <ChevronUp size={14} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            title="Move down"
            aria-label={`Move ${stage.name || `stage ${index + 1}`} down`}
            style={iconBtn(index === total - 1)}
          >
            <ChevronDown size={14} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onPatch({ expanded: !stage.expanded })}
            title={expanded ? 'Collapse' : 'Expand'}
            aria-label={expanded ? 'Collapse stage' : 'Expand stage'}
            aria-expanded={expanded}
            style={iconBtn(false)}
          >
            {expanded ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
          </button>
          {/* WF-STG-05/06: the last stage cannot be removed. */}
          <button
            type="button"
            onClick={onRemove}
            disabled={total === 1}
            title={total === 1 ? 'A workflow needs at least one stage' : 'Remove Stage'}
            aria-label={`Remove Stage ${index + 1}`}
            style={{ ...iconBtn(total === 1), color: total === 1 ? C.muted : C.danger }}
          >
            <Trash2 size={14} aria-hidden />
          </button>
        </div>

        {problem ? (
          <p
            style={{
              margin: '10px 0 0',
              fontSize: 12,
              color: C.danger,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <AlertCircle size={13} aria-hidden /> {problem}
          </p>
        ) : null}

        {expanded ? (
          <div
            style={{
              marginTop: 13,
              display: 'grid',
              // §10.4: two columns on tablet and up, stacked below.
              gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
              gap: 12,
            }}
          >
            <label style={{ gridColumn: '1 / -1' }}>
              <span style={labelStyle}>Stage name *</span>
              <input
                className="input"
                data-stage-name={stage.key}
                value={stage.name}
                maxLength={80}
                onChange={(e) => onPatch({ name: e.target.value })}
                placeholder="e.g. Finance Review"
              />
            </label>

            <div
              style={{ gridColumn: '1 / -1' }}
              role="group"
              aria-label={`Approver for ${stage.name || `stage ${index + 1}`}`}
            >
              <span style={labelStyle}>Approver *</span>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                {(
                  [
                    ['specific_user', 'Specific user', User],
                    ['submitter_manager', 'Submitter’s manager', Users],
                  ] as const
                ).map(([kind, label, Icon]) => {
                  const active = stage.approverKind === kind;
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() =>
                        onPatch({
                          approverKind: kind,
                          ...(kind === 'submitter_manager' ? { approverUserId: '' } : {}),
                        })
                      }
                      aria-pressed={active}
                      style={{
                        minHeight: 44,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 7,
                        padding: '0 13px',
                        borderRadius: 10,
                        cursor: 'pointer',
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: active ? C.primary : C.body,
                        background: active
                          ? `color-mix(in srgb, ${C.primary} 12%, transparent)`
                          : C.overlay,
                        border: `1px solid ${active ? C.primary : C.borderSubtle}`,
                      }}
                    >
                      <Icon size={13} aria-hidden /> {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {stage.approverKind === 'specific_user' ? (
              <label style={{ gridColumn: '1 / -1' }} htmlFor={`approver-${stage.key}`}>
                <span style={labelStyle}>Who approves this stage *</span>
                <SearchableSelect
                  id={`approver-${stage.key}`}
                  value={stage.approverUserId}
                  onChange={(v) => onPatch({ approverUserId: v })}
                  options={people}
                  placeholder="Search people by name or email"
                  emptyText="No one matches that search"
                />
              </label>
            ) : (
              /* WF-STG-B2: an info panel, not an input. */
              <p
                style={{
                  gridColumn: '1 / -1',
                  margin: 0,
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  color: C.body,
                  background: C.overlay,
                  border: `1px solid ${C.borderSubtle}`,
                  borderRadius: 10,
                  padding: '10px 12px',
                }}
              >
                Assigned automatically to the manager of whoever submits the
                document.
              </p>
            )}

            <label htmlFor={`dept-${stage.key}`}>
              <span style={labelStyle}>Department</span>
              <SearchableSelect
                id={`dept-${stage.key}`}
                value={stage.departmentId}
                onChange={(v) => onPatch({ departmentId: v })}
                options={departments}
                placeholder="Choose a department"
                emptyText="No department matches"
              />
            </label>

            <div
              role="group"
              aria-label={`Due within, for ${stage.name || `stage ${index + 1}`}`}
            >
              <span style={labelStyle}>Due within *</span>
              <div style={{ display: 'flex', gap: 7 }}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={stage.dueValue}
                  onChange={(e) =>
                    onPatch({ dueValue: Math.max(1, Number(e.target.value) || 1) })
                  }
                  style={{ flex: '1 1 90px' }}
                  aria-label="Due within amount"
                />
                <select
                  className="input"
                  value={stage.dueUnit}
                  onChange={(e) =>
                    onPatch({ dueUnit: e.target.value as 'hours' | 'days' })
                  }
                  style={{ flex: '0 0 110px' }}
                  aria-label="Due within unit"
                >
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                </select>
              </div>
              {/* inline-flex: Tailwind's preflight makes svg display:block,
                  which dropped the clock onto a line of its own. */}
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  marginTop: 5,
                  fontSize: 11.5,
                  color: C.muted,
                }}
              >
                <Clock size={11} aria-hidden /> = {hoursOf(stage)} hours
              </span>
            </div>

            <label
              style={{
                gridColumn: '1 / -1',
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                minHeight: 44,
              }}
            >
              <input
                type="checkbox"
                checked={signingOn}
                disabled={signingLocked}
                onChange={(e) => onPatch({ requireSigning: e.target.checked })}
              />
              <span
                style={{
                  fontSize: 12.5,
                  color: C.body,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {signingLocked ? (
                  <Lock size={12} color={C.warning} aria-hidden />
                ) : (
                  <ShieldCheck size={12} aria-hidden />
                )}
                Require a signing step
                {signingLocked ? (
                  <em style={{ color: C.muted, fontStyle: 'normal', fontSize: 11.5 }}>
                    — mandatory for this department
                  </em>
                ) : null}
              </span>
            </label>
          </div>
        ) : null}
      </div>
    </li>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11.5,
  color: 'var(--text-muted)',
  marginBottom: 5,
};

function iconBtn(disabled: boolean): React.CSSProperties {
  return {
    width: 44,
    height: 44,
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    background: 'transparent',
    border: 'none',
    borderRadius: 8,
    color: 'var(--text-muted)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
  };
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function WorkflowBuilderPage() {
  const { id: templateId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = !!templateId;

  const [step, setStep] = useState(0); // 0 = Build, 1 = Preview
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'organization'>('private');
  const [requireFullReapproval, setRequireFullReapproval] = useState(false);
  // WF-BLD-04: a new workflow starts with one stage so the user sees what to do.
  const [stages, setStages] = useState<StageDraft[]>(() => [emptyStage(0)]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const undoRef = useRef<{ stage: StageDraft; index: number; timer: number } | null>(null);

  const { data: existing, isLoading: loadingExisting } = useWorkflowDetail(templateId);
  const { data: versions } = useWorkflowVersions(templateId);
  const { data: membersPage } = useMembers({ limit: 100 });
  const { data: departments = [] } = useDepartments();
  const saveM = useSaveWorkflow(templateId);

  const people = useMemo(
    () =>
      (membersPage?.items ?? [])
        .filter((m) => m.status === 'active' && m.role?.name !== 'trainee')
        .map((m) => ({
          value: m.user_id,
          label: m.user?.name || m.user?.email || 'Unknown user',
          hint: m.user?.email,
        })),
    [membersPage],
  );

  const deptOptions = useMemo(
    () => departments.map((d) => ({ value: d.id, label: d.name })),
    [departments],
  );

  // WF-STG-20: which departments force signing on.
  const signingLockedDepts = useMemo(
    () =>
      new Set(
        departments
          .filter((d) => (d as { requires_signature?: boolean }).requires_signature)
          .map((d) => d.id),
      ),
    [departments],
  );

  // Load an existing definition into the draft.
  //
  // `department_id` and the due-within wording come from the API's restored
  // version fields. Before they were served, this set `departmentId: ''` and
  // re-derived the deadline from `sla_hours` — so opening any workflow in the
  // editor and saving it dropped every stage's department, and with it the
  // department-mandated signing lock (WF-STG-20). The `??` fallbacks keep a
  // workflow created before versioning editable.
  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setDescription(existing.description ?? '');
    setVisibility(existing.visibility);
    setRequireFullReapproval(!!existing.require_full_reapproval);
    setStages(
      [...existing.stages]
        .sort((a, b) => a.sequence_order - b.sequence_order)
        .map((s) => {
          const rule = s.approver_rules[0];
          const kind: ApproverKind =
            rule?.rule_type === 'manager_of_requester'
              ? 'submitter_manager'
              : 'specific_user';
          const hours = s.sla_hours ?? 48;
          const useDays = hours % 24 === 0;
          return {
            key: nextKey(),
            name: s.name,
            approverKind: kind,
            approverUserId:
              kind === 'specific_user'
                ? s.approver_user_id ??
                  String((rule?.rule_value as { user_id?: string })?.user_id ?? '')
                : '',
            departmentId: s.department_id ?? '',
            dueValue: s.due_within_value ?? (useDays ? hours / 24 : hours),
            dueUnit: s.due_within_unit ?? (useDays ? 'days' : 'hours'),
            requireSigning: s.requires_signature,
            expanded: false,
          };
        }),
    );
    setDirty(false);
  }, [existing]);

  // WF-BLD-03: never lose unsaved work silently. Covers reload and tab close;
  // in-app navigation is guarded by the Cancel handler below.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(
    () => () => {
      if (undoRef.current) window.clearTimeout(undoRef.current.timer);
    },
    [],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function mutate(next: StageDraft[]) {
    setStages(next);
    setDirty(true);
  }

  function patchStage(index: number, patch: Partial<StageDraft>) {
    const next = stages.map((s, i) => (i === index ? { ...s, ...patch } : s));
    // Expanding or collapsing a card is a view change, not an edit. Routing it
    // through mutate() marked the form dirty, so opening a workflow, clicking
    // one chevron and leaving raised "Discard your changes?" over nothing.
    const viewOnly = Object.keys(patch).every((k) => k === 'expanded');
    if (viewOnly) setStages(next);
    else mutate(next);
  }

  function move(index: number, dir: -1 | 1) {
    const to = index + dir;
    if (to < 0 || to >= stages.length) return;
    const next = [...stages];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    mutate(next);
    // UX-A11Y-04 / WF-STG-08.
    setAnnouncement(
      `${moved.name || `Stage ${index + 1}`} moved to position ${to + 1} of ${next.length}`,
    );
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = stages.findIndex((s) => s.key === active.id);
    const to = stages.findIndex((s) => s.key === over.id);
    if (from < 0 || to < 0) return;
    const next = [...stages];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    mutate(next);
    setAnnouncement(
      `${moved.name || `Stage ${from + 1}`} moved to position ${to + 1} of ${next.length}`,
    );
  }

  /**
   * WF-STG-06: removing a stage that has data uses an Undo toast rather than a
   * blocking modal, and restores it at its previous position with all values.
   */
  function removeStage(index: number) {
    if (stages.length === 1) return;
    const victim = stages[index];
    const touched =
      victim.name.trim() !== '' || victim.approverUserId !== '' || victim.departmentId !== '';
    mutate(stages.filter((_, i) => i !== index));

    if (!touched) return;

    const timer = window.setTimeout(() => {
      undoRef.current = null;
    }, UNDO_MS);
    undoRef.current = { stage: victim, index, timer };

    toast(`Removed “${victim.name || `Stage ${index + 1}`}”`, {
      duration: UNDO_MS,
      action: {
        label: 'Undo',
        onClick: () => {
          const saved = undoRef.current;
          if (!saved) return;
          window.clearTimeout(saved.timer);
          undoRef.current = null;
          setStages((prev) => {
            const next = [...prev];
            next.splice(Math.min(saved.index, next.length), 0, saved.stage);
            return next;
          });
        },
      },
    });
  }

  function addStage() {
    if (stages.length >= MAX_STAGES) return;
    const stage = emptyStage(stages.length);
    mutate([...stages, stage]);
    // WF-STG-01: focus the new stage's NAME field. Addressed by the stage's
    // own key rather than "the last input.input on the page", which landed on
    // the new card's due-within amount box instead.
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLInputElement>(`[data-stage-name="${stage.key}"]`)
        ?.focus();
    });
  }

  /** Per-stage local problems, keyed by stage key (WF-BLD-05). */
  const problems = useMemo(() => {
    const out: Record<string, string> = {};
    const seen = new Map<string, number>();
    stages.forEach((s, i) => {
      const trimmed = s.name.trim();
      if (trimmed.length < 2) {
        out[s.key] = 'Name this stage (at least 2 characters).';
      } else {
        const key = trimmed.toLowerCase();
        if (seen.has(key)) out[s.key] = 'Stage names must be unique in a workflow.';
        seen.set(key, i);
      }
      if (!out[s.key] && s.approverKind === 'specific_user' && !s.approverUserId) {
        out[s.key] = 'Select an approver.';
      }
      const h = hoursOf(s);
      if (!out[s.key] && (h < 1 || h > 720)) {
        out[s.key] = 'Enter a due time between 1 hour and 30 days.';
      }
    });
    return out;
  }, [stages]);

  const nameProblem =
    name.trim().length < 3 ? 'Enter a workflow name (at least 3 characters).' : null;
  const blocked = !!nameProblem || Object.keys(problems).length > 0;

  // WF-STG-12: non-blocking amber warnings.
  const warnings = useMemo(() => {
    const out: string[] = [];
    for (let i = 1; i < stages.length; i++) {
      const a = stages[i - 1];
      const b = stages[i];
      if (
        a.approverKind === 'specific_user' &&
        b.approverKind === 'specific_user' &&
        a.approverUserId &&
        a.approverUserId === b.approverUserId
      ) {
        out.push(
          `The same person approves Step ${i} and Step ${i + 1} in a row.`,
        );
      }
    }
    return out;
  }, [stages]);

  const previewStages: PreviewStage[] = stages.map((s) => ({
    name: s.name,
    approverType: s.approverKind,
    approverName:
      s.approverKind === 'specific_user'
        ? people.find((p) => p.value === s.approverUserId)?.label ?? null
        : null,
    departmentName: deptOptions.find((d) => d.value === s.departmentId)?.label ?? null,
    dueWithinValue: s.dueValue,
    dueWithinUnit: s.dueUnit,
    requireSigning: s.requireSigning || signingLockedDepts.has(s.departmentId),
    signingLocked: signingLockedDepts.has(s.departmentId),
  }));

  function toPayload(): WorkflowTemplateInput {
    const stageInputs: WorkflowStageInput[] = stages.map((s, i) => ({
      name: s.name.trim(),
      sequence_order: i + 1,
      min_approvals_required: 1,
      sla_hours: hoursOf(s),
      due_within_value: s.dueValue,
      due_within_unit: s.dueUnit,
      department_id: s.departmentId || null,
      requires_signature: s.requireSigning,
      reapproval_on_revision: false,
      approver_rules: [
        s.approverKind === 'submitter_manager'
          ? { rule_type: 'manager_of_requester' as const, rule_value: {} }
          : {
              rule_type: 'specific_user' as const,
              rule_value: { user_id: s.approverUserId },
            },
      ],
    }));
    return {
      name: name.trim(),
      description: description.trim() || null,
      require_full_reapproval: requireFullReapproval,
      stages: stageInputs,
    };
  }

  async function onSave() {
    setServerError(null);
    try {
      await saveM.mutateAsync({ payload: toPayload(), visibility });
      setDirty(false);
      // UX-INT-06: success only after the server confirms.
      toast.success(isEdit ? 'Workflow saved as a new version' : 'Workflow created');
      navigate('/workflows');
    } catch (err) {
      // WF-PRV-08: keep everything, show the server's own message, offer retry.
      const msg =
        err instanceof ApiClientError
          ? err.detail
          : err instanceof Error
            ? err.message
            : 'Could not save this workflow';
      setServerError(msg);
      setStep(0);
    }
  }

  function onCancel() {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    navigate('/workflows');
  }

  const currentVersion = versions?.find((v) => v.is_current)?.version_number;

  return (
    /* `page-content` is the app's page gutter, which this page was missing
       entirely. The column is 760 — WorkflowPreview's own width — so moving
       Build -> Preview no longer shifts the content sideways from 960 to 760.
       It is also a comfortable form measure. */
    <div className="page-content" style={{ paddingTop: 24, maxWidth: 760, margin: '0 auto' }}>
      <PageHeader
        title={isEdit ? 'Edit workflow' : 'New workflow'}
        description={
          isEdit
            ? 'Saving creates a new version. Documents already in approval keep running on the version they were submitted with.'
            : 'Define the ordered approval route. You can reuse this workflow whenever you submit a document.'
        }
        breadcrumbs={[{ label: 'Workflows', to: '/workflows' }]}
        actions={
          <button type="button" onClick={onCancel} style={ghostBtn}>
            <ArrowLeft size={14} aria-hidden /> Back
          </button>
        }
      />

      {/* Live region for reorder announcements (UX-A11Y-04). */}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div>
        <div style={{ margin: '14px 0 20px' }}>
          <Stepper
            steps={[{ key: 'build', label: 'Build' }, { key: 'preview', label: 'Preview' }]}
            current={step}
            maxReached={blocked ? 0 : 1}
            onStepClick={(i) => {
              if (i === 1 && blocked) return;
              setStep(i);
            }}
          />
        </div>

        {isEdit && loadingExisting ? (
          <p style={{ color: C.muted, fontSize: 13 }}>Loading workflow…</p>
        ) : null}

        {isEdit && currentVersion ? (
          <p style={banner(C.primary)}>
            <Info size={13} aria-hidden /> This workflow is on version{' '}
            {currentVersion}. Saving creates version {currentVersion + 1}; in-flight
            runs are unaffected.
          </p>
        ) : null}

        {serverError ? (
          <p style={banner(C.danger)} role="alert">
            <AlertCircle size={13} aria-hidden /> {serverError}
          </p>
        ) : null}

        {step === 0 ? (
          <>
            {/* Workflow details — §5.3 */}
            <section
              style={{
                background: C.card,
                border: `1px solid ${C.border}`,
                borderRadius: 16,
                padding: 18,
                marginBottom: 18,
              }}
            >
              <h2 style={sectionTitle}>Workflow details</h2>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  gap: 13,
                }}
              >
                <label>
                  <span style={labelStyle}>Workflow name *</span>
                  <input
                    className="input"
                    value={name}
                    maxLength={100}
                    onChange={(e) => {
                      setName(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="e.g. Purchase approval over 5k"
                    aria-invalid={!!nameProblem}
                  />
                  {nameProblem ? (
                    <span style={{ fontSize: 11.5, color: C.danger }}>{nameProblem}</span>
                  ) : null}
                </label>

                {!isEdit ? (
                  <label>
                    <span style={labelStyle}>Who can use it</span>
                    <select
                      className="input"
                      value={visibility}
                      onChange={(e) => {
                        setVisibility(e.target.value as 'private' | 'organization');
                        setDirty(true);
                      }}
                    >
                      <option value="private">Private to me (share it later)</option>
                      <option value="organization">Everyone in the organization</option>
                    </select>
                  </label>
                ) : null}

                <label style={{ gridColumn: '1 / -1' }}>
                  <span style={labelStyle}>Description</span>
                  <textarea
                    className="input"
                    value={description}
                    maxLength={500}
                    rows={2}
                    onChange={(e) => {
                      setDescription(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="What is this route for?"
                  />
                  <span style={{ fontSize: 11, color: C.muted }}>
                    {description.length}/500
                  </span>
                </label>

                {/* WF-BLD-07 */}
                <label
                  style={{
                    gridColumn: '1 / -1',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 9,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={requireFullReapproval}
                    onChange={(e) => {
                      setRequireFullReapproval(e.target.checked);
                      setDirty(true);
                    }}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ fontSize: 12.5, color: C.body }}>
                    Require full re-approval after changes
                    <span style={{ display: 'block', color: C.muted, fontSize: 11.5 }}>
                      When ON, a revised document restarts from Stage 1 instead of
                      returning to the stage that requested changes.
                    </span>
                  </span>
                </label>
              </div>
            </section>

            {/* Stages — §5.4 */}
            <section
              style={{
                background: C.card,
                border: `1px solid ${C.border}`,
                borderRadius: 16,
                padding: 18,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  marginBottom: 13,
                }}
              >
                <h2 style={{ ...sectionTitle, marginBottom: 0 }}>Approval stages</h2>
                <button
                  type="button"
                  onClick={() =>
                    // setStages, not mutate(): a view change must not mark the
                    // form dirty (see patchStage).
                    setStages(stages.map((s) => ({ ...s, expanded: !stages.every((x) => x.expanded) })))
                  }
                  style={ghostBtn}
                >
                  {stages.every((s) => s.expanded) ? 'Collapse all' : 'Expand all'}
                </button>
              </div>

              {warnings.length > 0 ? (
                <div style={banner(C.warning)}>
                  <AlertCircle size={13} aria-hidden />
                  <span>{warnings.join(' ')}</span>
                </div>
              ) : null}

              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={stages.map((s) => s.key)}
                  strategy={verticalListSortingStrategy}
                >
                  <ul style={{ display: 'grid', gap: 10, margin: 0, padding: 0 }}>
                    {stages.map((stage, i) => (
                      <StageCard
                        key={stage.key}
                        stage={stage}
                        index={i}
                        total={stages.length}
                        people={people}
                        departments={deptOptions}
                        signingLockedDepts={signingLockedDepts}
                        onPatch={(patch) => patchStage(i, patch)}
                        onRemove={() => removeStage(i)}
                        onMove={(dir) => move(i, dir)}
                        problem={problems[stage.key]}
                      />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>

              <button
                type="button"
                onClick={addStage}
                disabled={stages.length >= MAX_STAGES}
                title={stages.length >= MAX_STAGES ? `Maximum ${MAX_STAGES} stages.` : undefined}
                style={{
                  marginTop: 12,
                  minHeight: 44,
                  width: '100%',
                  borderRadius: 10,
                  border: `1px dashed ${C.border}`,
                  background: 'transparent',
                  color: stages.length >= MAX_STAGES ? C.muted : C.primary,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: stages.length >= MAX_STAGES ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 7,
                }}
              >
                <Plus size={14} aria-hidden /> Add stage
                {stages.length >= MAX_STAGES ? ` — maximum ${MAX_STAGES}` : ''}
              </button>
            </section>
          </>
        ) : (
          <section style={{ paddingTop: 4 }}>
            <WorkflowPreview
              name={name}
              description={description}
              stages={previewStages}
              requireFullReapproval={requireFullReapproval}
            />
          </section>
        )}
      </div>

      {/* Action bar — WF-PRV-07, UX-RSP-01.
          Sticky INSIDE the content column rather than fixed to the viewport:
          it then shares the form's left and right edges automatically and
          follows the sidebar when it collapses, which the fixed version did
          not. */}
      <div
        style={{
          position: 'sticky',
          bottom: 16,
          marginTop: 20,
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          boxShadow: 'var(--shadow-lg)',
          padding: 12,
          zIndex: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: 9,
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <button type="button" onClick={onCancel} style={ghostBtn}>
            Cancel
          </button>
          {step === 1 ? (
            <button type="button" onClick={() => setStep(0)} style={secondaryBtn}>
              Edit workflow
            </button>
          ) : null}
          {step === 0 ? (
            <button
              type="button"
              onClick={() => setStep(1)}
              disabled={blocked}
              style={{ ...primaryBtn, opacity: blocked ? 0.55 : 1 }}
              title={blocked ? 'Fix the highlighted problems first' : undefined}
            >
              Preview workflow
            </button>
          ) : (
            <button
              type="button"
              onClick={onSave}
              disabled={saveM.isPending}
              style={{ ...primaryBtn, opacity: saveM.isPending ? 0.7 : 1 }}
            >
              {saveM.isPending ? (
                <>
                  <Loader2 size={14} className="wbspin" aria-hidden /> Saving…
                </>
              ) : isEdit ? (
                'Save workflow'
              ) : (
                'Create workflow'
              )}
            </button>
          )}
        </div>
      </div>

      <div style={{ height: 8 }} />

      {/* WF-BLD-03. Was a native window.confirm(), the only dialog in the
          module the theme could not reach and the only one that said nothing
          about what is at stake. */}
      <ConfirmDialog
        open={confirmDiscard}
        title="Discard your changes?"
        message={
          isEdit
            ? 'The edits you have made to this workflow will be lost. The saved version is unchanged.'
            : 'This workflow has not been created yet, so everything you have entered will be lost.'
        }
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setConfirmDiscard(false);
          navigate('/workflows');
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  margin: '0 0 13px',
  fontSize: 14,
  fontWeight: 800,
  color: 'var(--text-primary)',
};

function banner(color: string): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    margin: '0 0 14px',
    fontSize: 12.5,
    lineHeight: 1.5,
    color,
    background: `color-mix(in srgb, ${color} 9%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 26%, transparent)`,
    borderRadius: 10,
    padding: '10px 12px',
  };
}

const baseBtn: React.CSSProperties = {
  minHeight: 44,
  padding: '0 16px',
  borderRadius: 10,
  fontSize: 13.5,
  fontWeight: 700,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
};

const primaryBtn: React.CSSProperties = {
  ...baseBtn,
  border: 'none',
  background: 'var(--color-primary-400)',
  color: 'var(--color-primary-foreground, #fff)',
};

const secondaryBtn: React.CSSProperties = {
  ...baseBtn,
  background: 'var(--bg-overlay)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
};

const ghostBtn: React.CSSProperties = {
  ...baseBtn,
  background: 'transparent',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-secondary)',
};
