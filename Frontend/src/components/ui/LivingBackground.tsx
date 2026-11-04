/**
 * LivingBackground — one fixed decorative layer for the whole app (mounted once at the shell).
 * position:fixed, inset:0, z-index:-1, pointer-events:none, aria-hidden, NO background-color
 * (the body owns --background; blend modes composite against it).
 *
 * Light ("Ice Sheet"): 4-layer aura stack + 3 soft aurora blobs.
 * Dark ("Midnight Aurora"): deep-ink aurora blobs (screen blend) + faint vignette.
 * Both theme layer-sets render; CSS (.dark) toggles which is visible for an instant theme swap.
 *
 * Motion (transform/opacity only — never blur/filter):
 *   - aurora drift: blobs move ±40–80px, scale 1→1.12, 22–40s sine yoyo, phase-offset
 *   - floating motes: slow upward drift w/ sway (desktop only)
 *   - cursor parallax: blobs shift ≤12px opposite the pointer (gsap.quickTo, desktop only)
 * Safety: pauses on document.hidden; prefers-reduced-motion = fully static; low-power
 * (hardwareConcurrency ≤ 4 or width < 768) = 2 blobs, no motes, no parallax.
 */

import { useMemo, useRef, useState, useEffect } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { prefersReducedMotion } from '@/lib/motion';

interface LivingBackgroundProps {
  /** 'auth' uses a stronger wash for the auth/onboarding brand panel. */
  variant?: 'app' | 'auth';
}

const BLOBS_LIGHT = [
  { key: 'sky', color: '#38BDF8', alpha: 0.28, size: '46vw', top: '-10%', left: '58%' },
  { key: 'cyan', color: '#06B6D4', alpha: 0.2, size: '40vw', top: '34%', left: '-12%' },
  { key: 'indigo', color: '#818CF8', alpha: 0.18, size: '42vw', top: '66%', left: '40%' },
];
const BLOBS_DARK = [
  { key: 'sky', color: '#0EA5E9', alpha: 0.22, size: '48vw', top: '-12%', left: '60%' },
  { key: 'indigo', color: '#6366F1', alpha: 0.2, size: '44vw', top: '30%', left: '-14%' },
  { key: 'teal', color: '#14B8A6', alpha: 0.12, size: '40vw', top: '64%', left: '42%' },
];

export function LivingBackground({ variant = 'app' }: LivingBackgroundProps) {
  const scope = useRef<HTMLDivElement>(null);
  const [lowPower, setLowPower] = useState(false);

  useEffect(() => {
    const cores = (navigator as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency ?? 8;
    setLowPower(cores <= 4 || window.innerWidth < 768);
  }, []);

  const blobCount = lowPower ? 2 : 3;
  const strength = variant === 'auth' ? 1.25 : 1;

  const motes = useMemo(
    () =>
      Array.from({ length: 16 }).map((_, i) => ({
        id: i,
        left: Math.random() * 100,
        top: Math.random() * 100,
        size: 2 + Math.random() * 4,
        opacity: 0.15 + Math.random() * 0.25,
        dur: 18 + Math.random() * 16,
        delay: Math.random() * 10,
        sway: 10 + Math.random() * 24,
      })),
    [],
  );

  useGSAP(
    () => {
      const root = scope.current;
      if (!root || prefersReducedMotion()) return;

      const tweens: gsap.core.Tween[] = [];

      // Aurora drift on every visible blob (both theme sets share [data-blob]).
      root.querySelectorAll<HTMLElement>('[data-blob]').forEach((el, i) => {
        tweens.push(
          gsap.to(el, {
            x: (i % 2 === 0 ? 1 : -1) * (40 + i * 14),
            y: (i % 2 === 0 ? -1 : 1) * (36 + i * 10),
            scale: 1.12,
            duration: 22 + i * 6,
            ease: 'sine.inOut',
            repeat: -1,
            yoyo: true,
            delay: i * 1.5,
          }),
        );
      });

      // Floating motes (desktop only).
      if (!lowPower) {
        root.querySelectorAll<HTMLElement>('[data-mote]').forEach((el) => {
          const sway = Number(el.dataset.sway ?? 16);
          const dur = Number(el.dataset.dur ?? 24);
          tweens.push(
            gsap.to(el, { y: '-=120', duration: dur, ease: 'none', repeat: -1, modifiers: { y: gsap.utils.unitize((y) => parseFloat(y) % 140, 'px') } }),
          );
          tweens.push(gsap.to(el, { x: `+=${sway}`, duration: dur / 3, ease: 'sine.inOut', repeat: -1, yoyo: true }));
        });
      }

      // Cursor parallax (desktop only).
      let onMove: ((e: PointerEvent) => void) | null = null;
      if (!lowPower) {
        const blobs = Array.from(root.querySelectorAll<HTMLElement>('[data-blob]'));
        const setters = blobs.map((el) => ({
          x: gsap.quickTo(el, 'x', { duration: 0.8, ease: 'power3.out' }),
          y: gsap.quickTo(el, 'y', { duration: 0.8, ease: 'power3.out' }),
          base: gsap.getProperty(el, 'x') as number,
        }));
        onMove = (e: PointerEvent) => {
          const dx = (e.clientX / window.innerWidth - 0.5) * -24;
          const dy = (e.clientY / window.innerHeight - 0.5) * -24;
          setters.forEach((s, i) => {
            s.x((s.base as number) + dx * (0.4 + i * 0.1));
            s.y(dy * (0.4 + i * 0.1));
          });
        };
        window.addEventListener('pointermove', onMove, { passive: true });
      }

      // Pause all tweens while the tab is hidden.
      const onVis = () => {
        if (document.hidden) tweens.forEach((t) => t.pause());
        else tweens.forEach((t) => t.resume());
      };
      document.addEventListener('visibilitychange', onVis);

      return () => {
        if (onMove) window.removeEventListener('pointermove', onMove);
        document.removeEventListener('visibilitychange', onVis);
      };
    },
    { scope, dependencies: [lowPower] },
  );

  const renderBlobs = (set: typeof BLOBS_LIGHT) =>
    set.slice(0, blobCount).map((b) => (
      <div
        key={b.key}
        data-blob
        style={{
          position: 'absolute',
          top: b.top,
          left: b.left,
          width: b.size,
          height: b.size,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${b.color} 0%, transparent 70%)`,
          opacity: b.alpha * strength,
          filter: 'blur(90px)',
          willChange: 'transform',
          transform: 'translate(-50%, -50%)',
        }}
      />
    ));

  return (
    <div ref={scope} className="living-bg" aria-hidden="true">
      {/* ── LIGHT: Ice Sheet 4-layer stack ── */}
      <div className="lb-light" style={{ position: 'absolute', inset: 0 }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, rgba(224,242,254,0.95) 0%, rgba(186,230,253,0.70) 50%, rgba(125,211,252,0.45) 100%)', opacity: 0.5 * strength }} />
        <div style={{ position: 'absolute', inset: 0, mixBlendMode: 'multiply', filter: 'blur(65px)', background: 'linear-gradient(115deg, transparent 20%, rgba(6,182,212,0.24) 38%, transparent 42%, rgba(56,189,248,0.30) 62%, transparent 76%)' }} />
        <div style={{ position: 'absolute', inset: 0, mixBlendMode: 'multiply', filter: 'blur(120px)', background: 'radial-gradient(ellipse 45% 55% at 25% 35%, rgba(255,255,255,0.60) 0%, transparent 65%)' }} />
        <div style={{ position: 'absolute', inset: 0, mixBlendMode: 'multiply', filter: 'blur(54px)', background: 'linear-gradient(35deg, rgba(255,255,255,0.55), transparent 35%, rgba(255,255,255,0.25) 65%, transparent)' }} />
        <div style={{ position: 'absolute', inset: 0 }}>{renderBlobs(BLOBS_LIGHT)}</div>
      </div>

      {/* ── DARK: Midnight Aurora ── */}
      <div className="lb-dark" style={{ position: 'absolute', inset: 0 }}>
        <div style={{ position: 'absolute', inset: 0, mixBlendMode: 'screen' }}>{renderBlobs(BLOBS_DARK)}</div>
        {/* faint vignette */}
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 80% 70% at 50% 30%, transparent 40%, rgba(2,6,23,0.55) 100%)' }} />
      </div>

      {/* ── Floating motes (both themes) ── */}
      {!lowPower && (
        <div style={{ position: 'absolute', inset: 0 }}>
          {motes.map((m) => (
            <span
              key={m.id}
              data-mote
              data-sway={m.sway}
              data-dur={m.dur}
              style={{
                position: 'absolute',
                left: `${m.left}%`,
                top: `${m.top}%`,
                width: m.size,
                height: m.size,
                borderRadius: '50%',
                background: 'var(--primary)',
                opacity: m.opacity,
                filter: 'blur(0.5px)',
                willChange: 'transform',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default LivingBackground;
