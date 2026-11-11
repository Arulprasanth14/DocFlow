/**
 * DocFlow Frontend — Workflow preview timeline (Workflow module §5.6)
 *
 * The read-only vertical timeline of a workflow's stages. Deliberately one
 * component rather than three: WF-PRV-09 requires the SAME preview on the
 * builder's confirm step, the workflow detail page and the upload selector,
 * so an approver route always looks identical wherever it is shown.
 *
 * WF-PRV-05 is the rule most easily got wrong here: a dynamic approver must
 * never be rendered as a fixed person. A "submitter's manager" stage shows
 * the RULE, because who it resolves to depends on who submits.
 */
import { ArrowDown, Building2, CheckCircle2, Clock, Lock, User, Users } from 'lucide-react';

const C = {
  card: 'var(--bg-elevated)',
  surface: 'var(--bg-surface)',
  border: 'var(--border-default)',
  borderSubtle: 'var(--border-subtle)',
  primary: 'var(--color-primary-400)',
  success: 'var(--color-success-400)',
  warning: 'var(--color-warning-400)',
  heading: 'var(--text-primary)',
  body: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
};

export interface PreviewStage {
  name: string;
  approverType: 'specific_user' | 'submitter_manager';
  /** Resolved display name for a fixed approver. Never set for a manager rule. */
  approverName?: string | null;
  departmentName?: string | null;
  dueWithinValue: number;
  dueWithinUnit: 'hours' | 'days';
  requireSigning: boolean;
  /** True when signing is mandatory because of the department, so the UI can
   *  show a lock rather than an ordinary badge (WF-STG-20). */
  signingLocked?: boolean;
}

export interface WorkflowPreviewProps {
  name: string;
  description?: string | null;
  stages: PreviewStage[];
  requireFullReapproval?: boolean;
  /** Compact cards once a workflow gets long (WF-PRV-06). */
  compact?: boolean;
}

function dueLabel(stage: PreviewStage): string {
  const n = stage.dueWithinValue;
  const unit = stage.dueWithinUnit === 'days' ? 'day' : 'hour';
  return `Due within ${n} ${unit}${n === 1 ? '' : 's'}`;
}

function Chip({
  icon: Icon,
  children,
  tone = 'muted',
}: {
  icon: React.ElementType;
  children: React.ReactNode;
  tone?: 'muted' | 'warning' | 'primary';
}) {
  const color =
    tone === 'warning' ? C.warning : tone === 'primary' ? C.primary : C.muted;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11.5,
        color,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 22%, transparent)`,
        borderRadius: 999,
        padding: '3px 9px',
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={12} aria-hidden />
      {children}
    </span>
  );
}

export function WorkflowPreview({
  name,
  description,
  stages,
  requireFullReapproval = false,
  compact: compactProp,
}: WorkflowPreviewProps) {
  // WF-PRV-06: more than six stages switches to compact cards so the action
  // bar stays reachable without hunting.
  const compact = compactProp ?? stages.length > 6;
  const pad = compact ? '12px 14px' : '16px 18px';

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', width: '100%' }}>
      {/* Header — WF-PRV-02 */}
      <header style={{ marginBottom: 18 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 800,
            color: C.heading,
            overflowWrap: 'anywhere',
          }}
        >
          {name || 'Untitled workflow'}
        </h2>
        {description ? (
          <p
            style={{
              margin: '6px 0 0',
              fontSize: 13,
              color: C.body,
              overflowWrap: 'anywhere',
            }}
          >
            {description}
          </p>
        ) : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 11 }}>
          <Chip icon={Users}>
            {stages.length} {stages.length === 1 ? 'stage' : 'stages'}
          </Chip>
          <Chip icon={ArrowDown}>Sequential approval</Chip>
          <Chip icon={CheckCircle2} tone={requireFullReapproval ? 'warning' : 'muted'}>
            Full re-approval after changes: {requireFullReapproval ? 'On' : 'Off'}
          </Chip>
        </div>
      </header>

      {/* Stages — WF-PRV-03/04 */}
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {stages.map((stage, i) => {
          const isFirst = i === 0;
          const isLast = i === stages.length - 1;
          return (
            <li key={`${stage.name}-${i}`}>
              <div
                style={{
                  background: C.card,
                  border: `1px solid ${C.border}`,
                  borderRadius: 14,
                  padding: pad,
                  display: 'flex',
                  gap: 13,
                  alignItems: 'flex-start',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 26,
                    height: 26,
                    borderRadius: 8,
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 12,
                    fontWeight: 800,
                    color: C.primary,
                    background: `color-mix(in srgb, ${C.primary} 12%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${C.primary} 28%, transparent)`,
                  }}
                >
                  {i + 1}
                </span>

                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 14.5,
                        fontWeight: 700,
                        color: C.heading,
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {stage.name || 'Untitled stage'}
                    </span>
                    {/* WF-PRV-04 */}
                    {isFirst ? <Chip icon={ArrowDown} tone="primary">Start</Chip> : null}
                    {isLast && stages.length > 1 ? (
                      <Chip icon={CheckCircle2} tone="primary">Final approval</Chip>
                    ) : null}
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 7,
                      marginTop: 9,
                    }}
                  >
                    {/* WF-PRV-03 + WF-PRV-05: a dynamic approver shows its RULE,
                        never a fixed person. */}
                    {stage.approverType === 'submitter_manager' ? (
                      <Chip icon={Users}>
                        Submitter&rsquo;s manager (assigned when the document is
                        submitted)
                      </Chip>
                    ) : (
                      <Chip icon={User}>
                        {stage.approverName || 'Approver not selected'}
                      </Chip>
                    )}
                    {stage.departmentName ? (
                      <Chip icon={Building2}>{stage.departmentName}</Chip>
                    ) : null}
                    <Chip icon={Clock}>{dueLabel(stage)}</Chip>
                    {stage.requireSigning ? (
                      <Chip icon={stage.signingLocked ? Lock : CheckCircle2} tone="warning">
                        Signature required
                      </Chip>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Connector — WF-PRV-03 "connected by arrows/line" */}
              {!isLast ? (
                <div
                  aria-hidden
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    padding: compact ? '4px 0' : '7px 0',
                  }}
                >
                  <ArrowDown size={15} color={C.muted} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* Terminal node — WF-PRV-04 */}
      <div
        aria-hidden
        style={{ display: 'flex', justifyContent: 'center', padding: '7px 0' }}
      >
        <ArrowDown size={15} color={C.muted} />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          background: `color-mix(in srgb, ${C.success} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${C.success} 26%, transparent)`,
          borderRadius: 14,
          padding: '12px 16px',
          color: C.success,
          fontWeight: 700,
          fontSize: 13.5,
        }}
      >
        <CheckCircle2 size={16} aria-hidden />
        Document approved
      </div>
    </div>
  );
}

export default WorkflowPreview;
