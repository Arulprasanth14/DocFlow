import React from 'react';
import { aiNotes, aiSrc, kb, prompts } from '../data';
import type { AiState } from '../useAiCycle';
import { Chip } from '../ui';
import { ink, shadow, surface } from '../tokens';

interface DockyProps {
  ai: AiState;
  ask: (i: number) => void;
}

/**
 * Docky, the policy assistant, shown rather than described: the mascot sits at
 * the centre of the company's own knowledge base, the documents orbit him, and
 * when a question arrives he looks at the one source he needs and cites it.
 *
 * The orbit, the beam, the float and the eye tracking all come from the engine.
 * React owns only the conversation state.
 */
export const Docky: React.FC<DockyProps> = ({ ai, ask }) => {
  const source = kb[aiSrc[ai.q]];
  const showQ = ai.phase !== 'idle';
  const searching = ai.phase === 'search';
  const showAnswer = ai.phase === 'answer' || ai.phase === 'done';

  const status =
    ai.phase === 'typing'
      ? 'Listening…'
      : ai.phase === 'search'
        ? `Reading ${source}…`
        : ai.phase === 'idle'
          ? 'Docky only reads your company’s own documents'
          : `Answered from ${source}`;

  return (
    <section
      id="ai"
      data-el="ai"
      aria-labelledby="ai-heading"
      style={{ position: 'relative', zIndex: 1, padding: '80px 24px 140px', scrollMarginTop: 96 }}
    >
      <div style={{ maxWidth: 1240, margin: '0 auto' }}>
        <div data-reveal="0" style={{ textAlign: 'center', maxWidth: 840, margin: '0 auto' }}>
          <div
            style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center' }}
          >
            <span className="lp-eyebrow">Meet Docky</span>
            <Chip>Coming soon</Chip>
          </div>
          <h2
            id="ai-heading"
            className="lp-display"
            style={{
              margin: '14px 0 0',
              fontSize: 'clamp(38px, 4.8vw, 70px)',
              lineHeight: 1.04,
              textWrap: 'balance',
            }}
          >
            Meet Docky, the assistant that knows your company’s{' '}
            <em className="lp-word">policies.</em>
          </h2>
          <p style={{ margin: '18px 0 0', fontSize: 17, lineHeight: 1.65, color: ink(0.66) }}>
            Ask a question and Docky answers from your own company documents.
          </p>
        </div>

        <div
          style={{
            marginTop: 44,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 460px), 1fr))',
            gap: 24,
            alignItems: 'stretch',
          }}
        >
          {/* ── the stage: Docky inside his knowledge base ────────────────── */}
          <div
            data-el="aistage"
            data-reveal="0"
            data-fx="pop"
            aria-hidden="true"
            style={{
              position: 'relative',
              height: 'min(560px, 120vw)',
              borderRadius: 36,
              overflow: 'hidden',
              background: `radial-gradient(ellipse at 50% 55%, ${surface(0.9)}, ${surface(0.45)} 60%, ${surface(0.2)})`,
              border: `1px solid ${surface(0.85)}`,
              boxShadow: `0 40px 100px ${shadow(0.14)}, inset 0 1px 1px ${surface(1)}`,
            }}
          >
            <div
              data-el="kbring"
              style={{
                position: 'absolute',
                left: '50%',
                top: 'calc(50% + 10px)',
                width: 700,
                height: 320,
                transform: 'translate(-50%,-50%)',
                borderRadius: '50%',
                border: '1.5px dashed rgb(2 132 199 / 0.38)',
                background:
                  'radial-gradient(ellipse, rgb(125 211 252 / 0.22), rgb(196 181 253 / 0.08) 60%, transparent 72%)',
              }}
            />

            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 22,
                display: 'flex',
                justifyContent: 'center',
                zIndex: 12,
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 14px',
                  borderRadius: 999,
                  background: surface(0.85),
                  border: `1px solid ${ink(0.08)}`,
                  fontSize: 13,
                  color: ink(1),
                  boxShadow: `0 8px 24px ${shadow(0.08)}`,
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: 'var(--lp-accent)',
                  }}
                />
                Your private knowledge base · only your organization
              </span>
            </div>

            <svg
              aria-hidden="true"
              focusable="false"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                overflow: 'visible',
                zIndex: 5,
                pointerEvents: 'none',
              }}
            >
              <line
                data-el="beam"
                x1="0"
                y1="0"
                x2="0"
                y2="0"
                stroke="var(--lp-accent)"
                strokeWidth={3}
                strokeLinecap="round"
                strokeDasharray="1 9"
                style={{ opacity: 0, transition: 'opacity .4s' }}
              />
            </svg>

            {kb.map((n) => (
              <div
                key={n}
                data-orb=""
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: 132,
                  padding: 12,
                  borderRadius: 14,
                  background: surface(0.94),
                  border: `1px solid ${ink(0.08)}`,
                  display: 'grid',
                  gap: 7,
                  boxSizing: 'border-box',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 16,
                      height: 20,
                      flexShrink: 0,
                      borderRadius: '3px 7px 3px 3px',
                      background: 'linear-gradient(160deg,#E0F2FE,#93C5FD)',
                    }}
                  />
                  <span style={{ fontSize: 13, fontWeight: 500, color: ink(1), lineHeight: 1.2 }}>
                    {n}
                  </span>
                </div>
                <div style={{ height: 5, borderRadius: 3, background: ink(0.1), width: '90%' }} />
                <div style={{ height: 5, borderRadius: 3, background: ink(0.07), width: '62%' }} />
              </div>
            ))}

            {/* ── the mascot ─────────────────────────────────────────────── */}
            <div
              data-el="docky"
              style={{ position: 'absolute', left: 0, top: 0, width: 124, height: 150, zIndex: 6 }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: -40,
                  right: -40,
                  top: -40,
                  bottom: -40,
                  borderRadius: '50%',
                  background:
                    'radial-gradient(circle, rgb(125 211 252 / 0.55), rgb(196 181 253 / 0.2) 45%, transparent 68%)',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: 16,
                  right: 16,
                  bottom: -26,
                  height: 14,
                  borderRadius: '50%',
                  background: `radial-gradient(ellipse, ${shadow(0.28)}, transparent 70%)`,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: 24,
                  background: 'var(--lp-docky-body)',
                  boxShadow: `0 26px 50px ${shadow(0.22)}, inset 0 -10px 24px rgb(99 102 241 / 0.18), inset 0 2px 2px ${surface(1)}`,
                  clipPath: 'polygon(0 0, calc(100% - 38px) 0, 100% 38px, 100% 100%, 0 100%)',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  width: 38,
                  height: 38,
                  borderRadius: '0 0 0 10px',
                  background: 'var(--lp-docky-fold)',
                }}
              />

              <div style={{ position: 'absolute', top: 48, left: 26, display: 'flex', gap: 20 }}>
                {(['eyeL', 'eyeR'] as const).map((eye, i) => (
                  <div
                    key={eye}
                    data-el={eye}
                    style={{
                      width: 26,
                      height: 30,
                      borderRadius: '50%',
                      background: 'var(--lp-docky-eye)',
                      display: 'grid',
                      placeItems: 'center',
                      transition: 'transform .08s',
                    }}
                  >
                    <div
                      data-el={i === 0 ? 'pupL' : 'pupR'}
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: '50%',
                        background: 'var(--lp-docky-eye-light)',
                        margin: '-9px 0 0 7px',
                      }}
                    />
                  </div>
                ))}
              </div>

              <div
                style={{
                  position: 'absolute',
                  top: 84,
                  left: 14,
                  width: 18,
                  height: 9,
                  borderRadius: '50%',
                  background: 'var(--lp-docky-blush)',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 84,
                  right: 14,
                  width: 18,
                  height: 9,
                  borderRadius: '50%',
                  background: 'var(--lp-docky-blush)',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 86,
                  left: '50%',
                  width: 20,
                  height: 10,
                  marginLeft: -10,
                  borderBottom: '3px solid var(--lp-docky-eye)',
                  borderRadius: '0 0 14px 14px',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: 28,
                  right: 28,
                  top: 114,
                  display: 'grid',
                  gap: 6,
                }}
              >
                <div style={{ height: 5, borderRadius: 3, background: 'rgb(2 132 199 / 0.28)' }} />
                <div
                  style={{
                    height: 5,
                    width: '60%',
                    borderRadius: 3,
                    background: 'rgb(147 51 234 / 0.22)',
                  }}
                />
              </div>
            </div>

            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 22,
                display: 'flex',
                justifyContent: 'center',
                zIndex: 12,
              }}
            >
              <span
                style={{
                  padding: '8px 16px',
                  borderRadius: 999,
                  background: surface(0.85),
                  border: `1px solid ${ink(0.08)}`,
                  fontSize: 14,
                  color: ink(1),
                }}
              >
                {status}
              </span>
            </div>
          </div>

          {/* ── the conversation ──────────────────────────────────────────── */}
          <div
            data-reveal="2"
            data-fx="flip"
            className="liquid-glass"
            style={{
              borderRadius: 32,
              background: surface(0.72),
              boxShadow: `0 40px 100px ${shadow(0.14)}, inset 0 1px 1px ${surface(1)}`,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '18px 22px',
                borderBottom: `1px solid ${ink(0.08)}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 32,
                    height: 38,
                    borderRadius: '7px 14px 7px 7px',
                    background: 'linear-gradient(160deg,#FFFFFF,#BAE6FD 60%,#C7D2FE)',
                    boxShadow: '0 6px 16px rgb(2 132 199 / 0.25)',
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0,
                  }}
                >
                  <span style={{ display: 'flex', gap: 6 }}>
                    <span style={{ width: 5, height: 7, borderRadius: 3, background: '#0B1B33' }} />
                    <span style={{ width: 5, height: 7, borderRadius: 3, background: '#0B1B33' }} />
                  </span>
                </span>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 500 }}>Docky</div>
                  <div style={{ fontSize: 13, color: ink(0.6) }}>
                    Answers only from your company’s own documents and policies.
                  </div>
                </div>
              </div>
              <span
                style={{
                  fontSize: 13,
                  padding: '4px 10px',
                  borderRadius: 999,
                  background: 'rgb(167 139 250 / 0.14)',
                  color: 'var(--lp-violet-chip-fg)',
                  whiteSpace: 'nowrap',
                }}
              >
                Preview
              </span>
            </div>

            <div
              style={{
                flex: 1,
                minHeight: 270,
                padding: 22,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                gap: 14,
              }}
            >
              {showQ && (
                <div
                  style={{
                    alignSelf: 'flex-end',
                    maxWidth: '85%',
                    padding: '12px 16px',
                    borderRadius: '18px 18px 4px 18px',
                    background: 'linear-gradient(100deg,#0284C7,#6366F1)',
                    color: '#fff',
                    fontSize: 15,
                    lineHeight: 1.55,
                    boxShadow: '0 10px 26px rgb(79 70 229 / 0.25)',
                  }}
                >
                  {ai.typed}
                  {ai.phase === 'typing' && <span style={{ opacity: 0.75 }}>▍</span>}
                </div>
              )}

              {searching && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 14,
                    color: ink(0.65),
                  }}
                >
                  <span aria-hidden="true" style={{ display: 'flex', gap: 4 }}>
                    <span
                      style={{ width: 6, height: 6, borderRadius: '50%', background: '#0284C7' }}
                    />
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: '#4F46E5',
                        opacity: 0.7,
                      }}
                    />
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: '#9333EA',
                        opacity: 0.45,
                      }}
                    />
                  </span>
                  Reading {source}…
                </div>
              )}

              {showAnswer && (
                <div
                  style={{
                    maxWidth: '90%',
                    padding: '14px 16px',
                    borderRadius: '18px 18px 18px 4px',
                    background: surface(1),
                    border: `1px solid ${ink(0.08)}`,
                    color: ink(1),
                    fontSize: 15,
                    lineHeight: 1.6,
                    boxShadow: `0 10px 30px ${shadow(0.08)}`,
                  }}
                >
                  <div>{ai.answer}</div>
                  <div
                    style={{
                      marginTop: 10,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 13,
                      padding: '4px 10px',
                      borderRadius: 999,
                      background: 'rgb(2 132 199 / 0.08)',
                      color: 'var(--lp-accent-deep)',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 10,
                        height: 12,
                        borderRadius: '2px 4px 2px 2px',
                        background: 'var(--lp-ramp-1)',
                      }}
                    />
                    Source · {source}
                  </div>
                </div>
              )}
            </div>

            <div
              style={{
                padding: '16px 22px 22px',
                display: 'grid',
                gap: 8,
                borderTop: `1px solid ${ink(0.08)}`,
              }}
            >
              <div style={{ fontSize: 13, color: ink(0.55) }}>Try a question</div>
              {prompts.map((t, i) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => ask(i)}
                  aria-pressed={i === ai.q}
                  style={{
                    textAlign: 'left',
                    padding: '11px 16px',
                    borderRadius: 14,
                    border: `1px solid ${i === ai.q ? 'rgb(2 132 199 / 0.45)' : ink(0.12)}`,
                    background: i === ai.q ? 'rgb(2 132 199 / 0.1)' : surface(0.6),
                    color: ink(1),
                    fontFamily: 'inherit',
                    fontSize: 15,
                    cursor: 'pointer',
                    transition: 'background .25s, border-color .25s',
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div
          data-reveal="0"
          style={{
            marginTop: 36,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          {aiNotes.map((t, i) => (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  padding: '9px 15px',
                  borderRadius: 999,
                  border: `1px solid ${ink(0.1)}`,
                  fontSize: 14,
                  background: surface(0.7),
                }}
              >
                {t}
              </span>
              {i < aiNotes.length - 1 && (
                <span aria-hidden="true" style={{ color: 'var(--lp-accent)' }}>
                  →
                </span>
              )}
            </div>
          ))}
        </div>

        <p
          style={{
            margin: '18px auto 0',
            maxWidth: 560,
            textAlign: 'center',
            fontSize: 15,
            lineHeight: 1.6,
            color: ink(0.55),
          }}
        >
          The AI is an extra helper. If it is ever unavailable, routing and approvals keep working as
          usual.
        </p>
      </div>
    </section>
  );
};

export default Docky;
