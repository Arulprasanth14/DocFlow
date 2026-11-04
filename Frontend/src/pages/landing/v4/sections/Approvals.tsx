import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apFeatures, approvalChips } from '../data';
import { Chip } from '../ui';
import { ink, shadow, surface } from '../tokens';

type ApState = 'pending' | 'approved' | 'changes';
interface LogEntry {
  t: string;
  c: string;
}

const FIRST_LOG: LogEntry = { t: 'Priya sent the Leave Request to Karthik.', c: '#93C5FD' };

/**
 * A working approval. Approve, send back or revoke, and the log records what
 * happened — including the point of the feature: a sent-back document comes
 * back as a new version with the old ones kept, and an approval can be undone
 * while the document is still open.
 */
export const Approvals: React.FC = () => {
  const [ap, setAp] = useState<ApState>('pending');
  const [version, setVersion] = useState(1);
  const [log, setLog] = useState<LogEntry[]>([FIRST_LOG]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const push = useCallback((t: string, c: string) => {
    setLog((prev) => [{ t, c }, ...prev].slice(0, 4));
  }, []);

  const approve = () => {
    if (ap !== 'pending') return;
    setAp('approved');
    push('Karthik approved. HR is next and can see his approval and comment.', '#6EE7B7');
  };

  const sendBack = () => {
    if (ap !== 'pending') return;
    setAp('changes');
    push('Karthik sent it back with notes. Earlier versions are kept.', '#FCD34D');
    timers.current.push(
      setTimeout(() => {
        setAp('pending');
        setVersion((v) => v + 1);
        push('Priya made the changes and sent a new version.', '#93C5FD');
      }, 1800)
    );
  };

  const revoke = () => {
    if (ap !== 'approved') return;
    setAp('pending');
    push('Karthik took his approval back. The document stays open.', '#64748B');
  };

  const reset = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setAp('pending');
    setVersion(1);
    setLog([FIRST_LOG]);
  };

  const chip = approvalChips[ap];
  const canAct = ap === 'pending';
  const canRevoke = ap === 'approved';

  const btn = (extra: React.CSSProperties): React.CSSProperties => ({
    padding: '11px 18px',
    borderRadius: 999,
    fontFamily: 'inherit',
    fontSize: 15,
    cursor: 'pointer',
    ...extra,
  });

  return (
    <section
      id="approvals"
      aria-labelledby="approvals-heading"
      style={{ position: 'relative', zIndex: 1, padding: '80px 24px 140px', scrollMarginTop: 96 }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))',
          gap: 56,
          alignItems: 'start',
        }}
      >
        <div data-reveal="0">
          {/* facts.ts has the approvals queue, revoke, and send-back all as
              in-progress / unconfirmed, so this section is chipped the same way
              Signatures and Docky are. */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="lp-eyebrow">Approvals</span>
            <Chip tone="amber">In progress</Chip>
          </div>
          <h2
            id="approvals-heading"
            className="lp-display"
            style={{ margin: '14px 0 0', fontSize: 'clamp(40px, 5vw, 72px)', lineHeight: 1.02 }}
          >
            Approvals that do not get <em className="lp-word">stuck.</em>
          </h2>
          <p style={{ margin: '18px 0 0', fontSize: 17, lineHeight: 1.65, color: ink(0.62) }}>
            One place to see what is waiting, what needs changes, and what is done.
          </p>

          <div style={{ marginTop: 36, display: 'grid' }}>
            {apFeatures.map((f) => (
              <div key={f.title} style={{ padding: '18px 0', borderTop: `1px solid ${ink(0.1)}` }}>
                <div style={{ fontFamily: 'var(--lp-font-display)', fontSize: 25 }}>{f.title}</div>
                <p style={{ margin: '6px 0 0', fontSize: 16, lineHeight: 1.6, color: ink(0.6) }}>
                  {f.desc}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div data-reveal="1" data-fx="stamp" style={{ position: 'sticky', top: 110 }}>
          <div style={{ fontSize: 15, color: ink(0.6), marginBottom: 14 }}>
            Try the buttons below to see how a decision works:
          </div>

          <div
            className="liquid-glass"
            style={{
              borderRadius: 28,
              padding: 28,
              background: surface(0.82),
              boxShadow: `0 40px 100px ${shadow(0.14)}, inset 0 1px 1px ${ink(0.12)}`,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontFamily: 'var(--lp-font-display)', fontSize: 30, lineHeight: 1 }}>
                  Leave Request
                </div>
                <div style={{ marginTop: 8, fontSize: 14, color: ink(0.6) }}>
                  From Priya · Waiting on Karthik · Version {version}
                </div>
              </div>
              <span
                aria-live="polite"
                style={{
                  fontSize: 13,
                  padding: '5px 12px',
                  borderRadius: 999,
                  background: chip.bg,
                  color: chip.fg,
                  whiteSpace: 'nowrap',
                  transition: 'all .35s',
                }}
              >
                {chip.label}
              </span>
            </div>

            <div aria-hidden="true" style={{ margin: '22px 0', height: 1, background: ink(0.08) }} />

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={approve}
                disabled={!canAct}
                className="lp-press"
                style={btn({
                  border: 'none',
                  background: 'var(--lp-mint)',
                  color: 'var(--lp-mint-ink)',
                  fontWeight: 500,
                  opacity: canAct ? 1 : 0.35,
                })}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={sendBack}
                disabled={!canAct}
                className="lp-press"
                style={btn({
                  border: '1px solid rgb(252 211 77 / 0.4)',
                  background: 'rgb(252 211 77 / 0.1)',
                  color: 'var(--lp-amber-ink)',
                  opacity: canAct ? 1 : 0.35,
                })}
              >
                Send back
              </button>
              <button
                type="button"
                onClick={revoke}
                disabled={!canRevoke}
                className="lp-press"
                style={btn({
                  border: `1px solid ${ink(0.2)}`,
                  background: 'transparent',
                  color: ink(1),
                  opacity: canRevoke ? 1 : 0.35,
                })}
              >
                Revoke approval
              </button>
            </div>

            <div style={{ marginTop: 24, display: 'grid', gap: 10 }} aria-live="polite">
              {log.map((l, i) => (
                <div
                  key={`${l.t}-${i}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '10px 1fr',
                    gap: 12,
                    alignItems: 'start',
                    fontSize: 15,
                    lineHeight: 1.5,
                    color: ink(0.8),
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      marginTop: 7,
                      background: l.c,
                    }}
                  />
                  <span>{l.t}</span>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={reset}
              style={{
                marginTop: 20,
                background: 'none',
                border: 'none',
                padding: 0,
                color: ink(0.5),
                fontFamily: 'inherit',
                fontSize: 14,
                cursor: 'pointer',
                textDecoration: 'underline',
                textUnderlineOffset: 3,
              }}
            >
              Reset demo
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Approvals;
