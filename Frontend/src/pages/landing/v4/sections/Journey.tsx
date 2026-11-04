import React from 'react';
import {
  activeNodeByStage,
  journeyNodes,
  stageChips,
  stages,
  trail as trailAll,
} from '../data';
import { ink, shadow, surface } from '../tokens';

interface JourneyProps {
  stage: number;
  w: number;
  h: number;
}

/** The confetti of paper scraps thrown at the moment of the decision. */
const BITS = [
  { w: 9, h: 12, r: 2, bg: '#fff', bd: 'rgb(5 150 105 / 0.4)' },
  { w: 7, h: 7, r: 2, bg: '#A7F3D0' },
  { w: 10, h: 6, r: 2, bg: '#BAE6FD' },
  { w: 8, h: 11, r: 2, bg: '#fff', bd: 'rgb(2 132 199 / 0.35)' },
  { w: 6, h: 6, r: '50%', bg: '#6EE7B7' },
  { w: 9, h: 7, r: 2, bg: '#DDD6FE' },
  { w: 7, h: 10, r: 2, bg: '#fff', bd: 'rgb(147 51 234 / 0.3)' },
  { w: 8, h: 8, r: 2, bg: '#A7F3D0' },
  { w: 6, h: 9, r: 2, bg: '#BAE6FD' },
  { w: 10, h: 7, r: 2, bg: '#fff', bd: 'rgb(5 150 105 / 0.35)' },
];

const ROUTE_D = 'M11 15 Q52 -4 89 19 Q106 50 88 80 Q50 102 12 80';

export const Journey: React.FC<JourneyProps> = ({ stage, w, h }) => {
  const narrow = w < 900;
  const short = h < 720;
  const chip = stageChips[stage];
  const activeNode = activeNodeByStage[stage];
  const trail = trailAll.slice(Math.max(0, stage - 2), stage + 1);
  const stamped = stage >= 3;

  return (
    <section
      id="journey"
      data-el="journey"
      aria-labelledby="journey-heading"
      style={{ position: 'relative', zIndex: 1, height: '560svh' }}
    >
      <div
        style={{
          position: 'sticky',
          top: 0,
          height: '100svh',
          overflow: 'hidden',
          boxSizing: 'border-box',
          padding: '88px 24px 20px',
        }}
      >
        <div
          style={{
            maxWidth: 1260,
            height: '100%',
            margin: '0 auto',
            display: 'grid',
            gridTemplateColumns: w < 700 ? '1fr' : '1.25fr .75fr',
            gridTemplateRows: w < 700 ? 'auto minmax(0,1fr)' : 'minmax(0,1fr)',
            gap: 'clamp(12px, 3vw, 48px)',
            alignItems: 'center',
          }}
        >
          {/* ── the stage: a document travelling between people ──────────── */}
          <div
            data-el="jstage"
            style={{
              position: 'relative',
              height: '100%',
              minHeight: 0,
              perspective: 1400,
              order: w < 700 ? 2 : 0,
            }}
          >
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: '70%',
                height: '70%',
                transform: 'translate(-50%,-50%)',
                borderRadius: '50%',
                background:
                  'radial-gradient(circle, rgb(56 189 248 / 0.28), rgb(167 139 250 / 0.12) 50%, transparent 70%)',
              }}
            />

            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                overflow: 'visible',
                zIndex: 1,
              }}
            >
              <path
                d={ROUTE_D}
                fill="none"
                stroke="rgb(2 132 199 / 0.12)"
                strokeWidth={10}
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
              />
              <path
                data-el="route"
                d={ROUTE_D}
                fill="none"
                stroke="rgb(2 132 199 / 0.55)"
                strokeWidth={2}
                strokeDasharray="2 9"
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
              />
            </svg>

            {journeyNodes.map((n, i) => {
              const on = i === activeNode;
              const done = i < activeNode;
              return (
                <div
                  key={n.i}
                  style={{
                    position: 'absolute',
                    left: n.x,
                    top: n.y,
                    transform: 'translate(-50%,-50%)',
                    zIndex: 6,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: '50%',
                      display: 'grid',
                      placeItems: 'center',
                      fontWeight: 600,
                      fontSize: 16,
                      background: on
                        ? 'linear-gradient(135deg,#38BDF8,#6366F1)'
                        : done
                          ? surface(1)
                          : surface(0.7),
                      color: on ? '#fff' : done ? 'var(--lp-accent)' : ink(0.45),
                      boxShadow: on
                        ? '0 0 0 8px rgb(56 189 248 / 0.18), 0 14px 34px rgb(79 70 229 / 0.35)'
                        : `0 8px 20px ${shadow(0.1)}`,
                      transform: `scale(${on ? 1.14 : 1})`,
                      transition: 'all .55s cubic-bezier(.34,1.56,.64,1)',
                      border: `1px solid ${surface(0.95)}`,
                    }}
                  >
                    {n.i}
                  </div>
                  <div
                    style={{
                      display: w < 1000 || short ? 'none' : 'block',
                      textAlign: 'center',
                      padding: '4px 10px',
                      borderRadius: 10,
                      background: surface(0.8),
                    }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 500, color: ink(1) }}>{n.n}</div>
                    <div style={{ fontSize: 13, color: ink(0.6) }}>{n.r}</div>
                  </div>
                </div>
              );
            })}

            {/* Karthik's comment, only while the document is Pending. */}
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: 'calc(19% + 76px)',
                width: 'min(190px, 22%)',
                boxSizing: 'border-box',
                zIndex: 7,
                padding: '12px 14px',
                borderRadius: '16px 4px 16px 16px',
                background: surface(1),
                border: `1px solid ${ink(0.08)}`,
                boxShadow: `0 20px 44px ${shadow(0.18)}`,
                opacity: stage === 2 && !narrow ? 1 : 0,
                transform: `scale(${stage === 2 ? 1 : 0.6})`,
                transformOrigin: '100% 0',
                transition: 'opacity .35s, transform .5s cubic-bezier(.34,1.56,.64,1)',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--lp-accent-deep)' }}>
                Karthik added a comment
              </div>
              <div style={{ marginTop: 8, display: 'grid', gap: 5 }}>
                <div style={{ height: 6, borderRadius: 3, background: ink(0.12), width: '95%' }} />
                <div style={{ height: 6, borderRadius: 3, background: ink(0.08), width: '70%' }} />
              </div>
            </div>

            {/* The packet riding the route between people. */}
            <div
              data-el="packet"
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                zIndex: 8,
                opacity: 0,
                width: 26,
                height: 32,
                borderRadius: '4px 10px 4px 4px',
                background: 'linear-gradient(160deg,#fff,#BAE6FD)',
                border: '1px solid rgb(2 132 199 / 0.4)',
                boxShadow: '0 0 0 6px rgb(56 189 248 / 0.18), 0 0 30px 8px rgb(56 189 248 / 0.45)',
              }}
            />

            {/* ── the document itself: four stacked sheets in 3D ─────────── */}
            <div
              data-el="docrig"
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: 340,
                height: 453,
                margin: '-226px 0 0 -170px',
                transformStyle: 'preserve-3d',
                zIndex: 3,
              }}
            >
              {[
                { z: -120, x: 30, y: 24, a: 0.5, b: 0.07 },
                { z: -80, x: 20, y: 16, a: 0.62, b: 0.08 },
                { z: -40, x: 10, y: 8, a: 0.75, b: 0.09 },
              ].map((s) => (
                <div
                  key={s.z}
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: 18,
                    background: surface(s.a),
                    border: `1px solid ${ink(s.b)}`,
                    transform: `translateZ(${s.z}px) translate(${s.x}px,${s.y}px)`,
                  }}
                />
              ))}

              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: 18,
                  background: 'var(--lp-paper)',
                  border: `1px solid ${ink(0.1)}`,
                  boxShadow: `0 50px 90px ${shadow(0.22)}, inset 0 1px 1px ${surface(1)}`,
                  padding: 26,
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 16,
                  overflow: 'hidden',
                  clipPath: 'polygon(0 0, calc(100% - 38px) 0, 100% 38px, 100% 100%, 0 100%)',
                }}
              >
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    width: 38,
                    height: 38,
                    background: 'var(--lp-paper-fold)',
                  }}
                />

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    paddingRight: 24,
                  }}
                >
                  <span style={{ fontFamily: 'var(--lp-font-display)', fontSize: 30, lineHeight: 1 }}>
                    Leave Request
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      padding: '4px 10px',
                      borderRadius: 999,
                      background: chip.bg,
                      color: chip.fg,
                      transition: 'all .4s',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {chip.label}
                  </span>
                </div>

                <div style={{ display: 'grid', gap: 10, fontSize: 14, color: ink(0.6) }}>
                  {[
                    ['From', 'Priya · Employee'],
                    ['Reviewer', 'Karthik · Manager'],
                    ['Then', 'HR'],
                  ].map(([label, value], i) => (
                    <div
                      key={label}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        borderBottom: i < 2 ? `1px solid ${ink(0.08)}` : undefined,
                        paddingBottom: i < 2 ? 10 : 0,
                      }}
                    >
                      <span>{label}</span>
                      <span data-fv="" style={{ color: ink(1), clipPath: 'inset(0 100% 0 0)' }}>
                        {value}
                      </span>
                    </div>
                  ))}
                </div>

                <div aria-hidden="true" style={{ display: 'grid', gap: 7 }}>
                  <div style={{ height: 7, borderRadius: 4, background: ink(0.1), width: '92%' }} />
                  <div style={{ height: 7, borderRadius: 4, background: ink(0.1), width: '78%' }} />
                  <div
                    style={{
                      height: 7,
                      borderRadius: 4,
                      background: 'rgb(2 132 199 / 0.25)',
                      width: '54%',
                    }}
                  />
                </div>

                <div style={{ marginTop: 'auto', display: 'grid', gap: 8 }}>
                  {trail.map((t) => (
                    <div
                      key={t}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 13,
                        color: ink(0.75),
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: 'var(--lp-accent)',
                          flexShrink: 0,
                        }}
                      />
                      {t}
                    </div>
                  ))}
                </div>

                <div
                  style={{
                    position: 'absolute',
                    right: 22,
                    top: '46%',
                    transform: `rotate(-14deg) scale(${stamped ? 1 : 2.2})`,
                    opacity: stamped ? 1 : 0,
                    transition:
                      'transform .5s cubic-bezier(.34,1.7,.5,1), opacity .25s',
                    border: `2.5px solid ${
                      stage === 4 ? 'var(--lp-stamp-archived)' : 'var(--lp-stamp-approved)'
                    }`,
                    color: stage === 4 ? 'var(--lp-stamp-archived)' : 'var(--lp-stamp-approved)',
                    borderRadius: 10,
                    padding: '6px 14px',
                    fontWeight: 600,
                    letterSpacing: '0.14em',
                    fontSize: 18,
                    background: surface(0.88),
                  }}
                >
                  {stage === 4 ? 'ARCHIVED' : 'APPROVED'}
                </div>
              </div>

              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  right: 70,
                  top: '50%',
                  width: 0,
                  height: 0,
                  transform: 'translateZ(10px)',
                }}
              >
                {BITS.map((b, i) => (
                  <span
                    key={i}
                    data-bit=""
                    style={{
                      position: 'absolute',
                      width: b.w,
                      height: b.h,
                      borderRadius: b.r,
                      background: b.bg,
                      border: b.bd ? `1px solid ${b.bd}` : undefined,
                      opacity: 0,
                    }}
                  />
                ))}
              </div>
            </div>

            {/* The archive drawer the document finally lands in. */}
            <div
              data-el="drawer"
              style={{
                position: 'absolute',
                left: '50%',
                bottom: '4%',
                width: 'min(340px, 72%)',
                height: 104,
                opacity: 0,
                transform: 'translate(-50%,40px)',
                borderRadius: 22,
                background: `linear-gradient(180deg, ${surface(0.35)}, ${surface(0.92)} 45%)`,
                border: `1px solid ${surface(0.95)}`,
                boxShadow: `0 30px 60px ${shadow(0.18)}, inset 0 1px 1px ${surface(1)}`,
                zIndex: 4,
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'center',
                paddingBottom: 16,
                boxSizing: 'border-box',
                fontSize: 14,
                color: ink(1),
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  aria-hidden="true"
                  style={{ width: 8, height: 8, borderRadius: '50%', background: '#4F46E5' }}
                />
                Archived · full history kept
              </span>
            </div>
          </div>

          {/* ── the five steps, written out ───────────────────────────────── */}
          <div style={{ minWidth: 0 }}>
            <div className="lp-eyebrow">How it works</div>
            <h2
              id="journey-heading"
              className="lp-display"
              style={{
                margin: '10px 0 0',
                fontSize: 'clamp(26px, min(3.2vw, 5.4svh), 48px)',
                lineHeight: 1.05,
                letterSpacing: '-0.02em',
              }}
            >
              Follow a document from first draft to <em className="lp-word">final archive.</em>
            </h2>

            <div
              style={{
                position: 'relative',
                marginTop: 'min(28px, 3svh)',
                display: 'grid',
                gap: narrow ? '0px' : 'min(18px, 1.6svh)',
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: 13,
                  top: 12,
                  bottom: 12,
                  width: 1,
                  background: ink(0.12),
                }}
              >
                <div
                  data-el="rail"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    transformOrigin: '50% 0',
                    transform: 'scaleY(0)',
                    background: 'var(--lp-grad-rail)',
                  }}
                />
              </div>

              {stages.map((s, i) => {
                const show = !(w < 700 || short) || i === stage;
                if (!show) return null;
                return (
                  <div
                    key={s.name}
                    style={{
                      position: 'relative',
                      display: 'grid',
                      gridTemplateColumns: '28px 1fr',
                      gap: 16,
                      opacity: i === stage ? 1 : 0.38,
                      transition: 'opacity .5s',
                    }}
                  >
                    <div style={{ paddingTop: 8, display: 'flex', justifyContent: 'center' }}>
                      <span
                        aria-hidden="true"
                        style={{
                          width: 11,
                          height: 11,
                          borderRadius: '50%',
                          background: i <= stage ? 'var(--lp-accent)' : ink(0.2),
                          boxShadow:
                            i === stage
                              ? '0 0 0 6px rgb(2 132 199 / 0.15), 0 0 18px rgb(2 132 199 / 0.45)'
                              : 'none',
                          transition: 'all .4s',
                        }}
                      />
                    </div>
                    <div>
                      <div className="lp-eyebrow" style={{ color: ink(0.5) }}>
                        {s.badge}
                      </div>
                      <div
                        style={{
                          fontFamily: 'var(--lp-font-display)',
                          fontSize: 'clamp(22px, 2.1vw, 30px)',
                          lineHeight: 1.1,
                          marginTop: 2,
                        }}
                      >
                        {s.name}
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateRows: i === stage ? '1fr' : '0fr',
                          transition: 'grid-template-rows .55s cubic-bezier(.16,1,.3,1)',
                        }}
                      >
                        <div style={{ overflow: 'hidden' }}>
                          <p
                            style={{
                              margin: '6px 0 0',
                              fontSize: 16,
                              lineHeight: 1.55,
                              color: ink(0.85),
                            }}
                          >
                            {s.summary}
                          </p>
                          <p
                            style={{
                              margin: '6px 0 0',
                              fontSize: 15,
                              lineHeight: 1.55,
                              color: ink(0.58),
                            }}
                          >
                            {s.details}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Journey;
