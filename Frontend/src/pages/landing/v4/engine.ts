import { useEffect, useRef } from 'react';
import { aiSrc } from './data';
import { createWave, type WaveHandle } from './wave';

/**
 * DocFlow Landing v4 — scroll + motion engine.
 *
 * Port of `componentDidMount` / `setupVideo` / `frame` from the design. One
 * `requestAnimationFrame` loop drives every scroll-linked and idle animation on
 * the page by writing inline styles directly.
 *
 * The design held ~40 `React.createRef()`s to do this. Here the loop resolves
 * its targets once by `data-` attribute from the landing root, which is how the
 * design already handled its repeated groups (`[data-q]`, `[data-plane]`,
 * `[data-orb]`, …). Sections stay plain presentational components with no
 * animation code in them.
 *
 * Nothing here ever touches React state per frame. The only value that flows
 * back into React is the journey stage index, which changes at most five times
 * across a 560svh scroll, via `onStage`.
 */

/** Values the loop needs to read from React, without re-subscribing. */
export interface EngineInputs {
  aiPhase: 'idle' | 'typing' | 'search' | 'answer' | 'done';
  aiQ: number;
}

export interface UseEngineArgs {
  rootRef: React.RefObject<HTMLElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Mutable mirror of the React values above. */
  inputsRef: React.RefObject<EngineInputs>;
  /** Called only when the journey stage index actually changes. */
  onStage: (stage: number) => void;
  /** Called if the hero video cannot play, so the hero keeps its light styling. */
  onVideoUnavailable: () => void;
  /** Called once the hero video is genuinely playing, so the hero goes to media styling. */
  onVideoReady: () => void;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

export function useV4Engine({
  rootRef,
  canvasRef,
  inputsRef,
  onStage,
  onVideoUnavailable,
  onVideoReady,
}: UseEngineArgs) {
  const stageRef = useRef(-1);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const rm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));

    const one = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
    const all = <T extends Element>(sel: string) => Array.from(root.querySelectorAll<T>(sel));

    // ── targets, resolved once ───────────────────────────────────────────────
    const bar = one('[data-el="bar"]');
    const nav = one('[data-el="nav"]');
    const aur0 = one('[data-el="aur0"]');
    const aurBlobs = all<HTMLElement>('[data-aur]');

    const hero = one('[data-el="hero"]');
    const heroVideo = one<HTMLVideoElement>('[data-el="hero-video"]');
    const heroContent = one('[data-el="hero-content"]');
    const heroCards = all<HTMLElement>('[data-hc]');

    const marquee = one('[data-el="marquee"]');

    const problem = one('[data-el="problem"]');
    const quoteCards = all<HTMLElement>('[data-q]');
    const probA = one('[data-el="probA"]');
    const probB = one('[data-el="probB"]');
    const flowPills = all<HTMLElement>('[data-fs]');

    const journey = one('[data-el="journey"]');
    const jStage = one('[data-el="jstage"]');
    const docRig = one('[data-el="docrig"]');
    const drawer = one('[data-el="drawer"]');
    const route = one<SVGPathElement>('[data-el="route"]');
    const packet = one('[data-el="packet"]');
    const fieldValues = all<HTMLElement>('[data-fv]');
    const bits = all<HTMLElement>('[data-bit]');
    const rail = one('[data-el="rail"]');

    const feat = one('[data-el="feat"]');

    const tenRig = one('[data-el="tenrig"]');
    const planes = all<HTMLElement>('[data-plane]');
    const walls = all<HTMLElement>('[data-wall]');

    const aiStage = one('[data-el="aistage"]');
    const orbs = all<HTMLElement>('[data-orb]');
    const docky = one('[data-el="docky"]');
    const beam = one<SVGLineElement>('[data-el="beam"]');
    const kbRing = one('[data-el="kbring"]');
    const eyeL = one('[data-el="eyeL"]');
    const eyeR = one('[data-el="eyeR"]');
    const pupL = one('[data-el="pupL"]');
    const pupR = one('[data-el="pupR"]');

    // ── pointer ──────────────────────────────────────────────────────────────
    const mouse = { x: 0, y: 0, cx: -1, cy: -1 };
    const onMouse = (e: MouseEvent) => {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
      mouse.cx = e.clientX;
      mouse.cy = e.clientY;
    };
    window.addEventListener('mousemove', onMouse, { passive: true });

    // ── video: play only while visible, loop without a black frame ───────────
    const vidIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const v = e.target as HTMLVideoElement;
          if (e.isIntersecting) void v.play().catch(() => {});
          else v.pause();
        }
      },
      { threshold: 0.05 }
    );
    for (const v of all<HTMLVideoElement>('[data-lazyvid]')) vidIO.observe(v);
    if (heroVideo) vidIO.observe(heroVideo);

    let vraf = 0;
    let vfb: ReturnType<typeof setTimeout> | undefined;
    let videoCleanup: (() => void) | undefined;
    const fadeVideo = (to: number) => {
      const v = heroVideo;
      if (!v) return;
      cancelAnimationFrame(vraf);
      const from = parseFloat(v.style.opacity) || 0;
      const t0 = performance.now();
      const step = (t: number) => {
        const p = Math.min(1, (t - t0) / 500);
        v.style.opacity = String(from + (to - from) * p);
        if (p < 1) vraf = requestAnimationFrame(step);
      };
      vraf = requestAnimationFrame(step);
      clearTimeout(vfb);
      vfb = setTimeout(() => {
        if ((parseFloat(v.style.opacity) || 0) !== to && performance.now() - t0 > 550) {
          v.style.opacity = String(to);
        }
      }, 650);
    };

    if (heroVideo) {
      const v = heroVideo;
      let started = false;
      let fadingOut = false;

      /**
       * Whether this element is actually showing footage.
       *
       * `playing` alone is not trustworthy. When the file is missing, the Vite
       * dev server answers the .mp4 request with index.html, and Chromium
       * accepts that as a media resource: readyState 4, `canplay` and
       * `playing` both fire, `error` stays null. The hero then switched to
       * white-on-media styling over a pale page and the headline vanished.
       *
       * A real video has non-zero intrinsic dimensions; a degenerate stream is
       * 0x0. That is the signal worth believing.
       */
      const hasRealFootage = () => v.videoWidth > 0 && v.videoHeight > 0;

      const onCanPlay = () => {
        if (started) return;
        started = true;
        void v.play().catch(() => {});
        fadeVideo(1);
      };
      // Fade out just before the end so the loop seam is invisible.
      const onTime = () => {
        if (!fadingOut && v.duration && v.duration - v.currentTime <= 0.55) {
          fadingOut = true;
          fadeVideo(0);
        }
      };
      const onEnded = () => {
        v.style.opacity = '0';
        later(() => {
          v.currentTime = 0;
          void v.play().catch(() => {});
          fadingOut = false;
          fadeVideo(1);
        }, 100);
      };
      const onPlaying = () => {
        if (hasRealFootage()) onVideoReady();
        else onVideoUnavailable();
        if (!fadingOut && (parseFloat(v.style.opacity) || 0) < 0.05) fadeVideo(1);
      };
      const onError = () => onVideoUnavailable();

      v.addEventListener('canplay', onCanPlay);
      v.addEventListener('timeupdate', onTime);
      v.addEventListener('ended', onEnded);
      v.addEventListener('playing', onPlaying);
      v.addEventListener('error', onError);
      if (v.readyState >= 3) onCanPlay();

      // If nothing has started after 1.5s the source is missing or blocked.
      later(() => {
        if (
          v.networkState === v.NETWORK_NO_SOURCE ||
          (!started && v.readyState < 2) ||
          !hasRealFootage()
        ) {
          onVideoUnavailable();
          return;
        }
        if (v.paused) void v.play().catch(() => {});
        if (!fadingOut && (parseFloat(v.style.opacity) || 0) < 0.05) v.style.opacity = '1';
      }, 1500);

      videoCleanup = () => {
        v.removeEventListener('canplay', onCanPlay);
        v.removeEventListener('timeupdate', onTime);
        v.removeEventListener('ended', onEnded);
        v.removeEventListener('playing', onPlaying);
        v.removeEventListener('error', onError);
      };
    }

    // ── particle field ───────────────────────────────────────────────────────
    let wave: WaveHandle | null = null;
    let disposed = false;
    if (canvasRef.current) {
      void createWave(canvasRef.current, root).then((w) => {
        if (disposed) {
          w?.dispose();
          return;
        }
        wave = w;
      });
    }
    // Re-read colour tokens on theme change without rebuilding the renderer.
    const themeObserver = new MutationObserver(() => wave?.updateTheme());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    // ── the loop ─────────────────────────────────────────────────────────────
    let last = performance.now();
    const t0 = last;
    let raf = 0;
    let hvLastTime = 0;
    let hvStall = 0;
    let orbA = 0;
    let orbSp = 0.22;
    let mqX = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = (now - t0) / 1000;
      const W = window.innerWidth;
      const H = window.innerHeight;

      const rr = root.getBoundingClientRect();
      const pageProg = clamp01(-rr.top / Math.max(1, rr.height - H));

      if (bar) bar.style.transform = `scaleX(${pageProg})`;
      if (nav) nav.dataset.stuck = rr.top < -60 ? '1' : '0';

      // Composited drift. This used to write background-position, which forced
      // a full-viewport repaint of the gradient every frame.
      if (!rm && aur0) {
        aur0.style.transform = `translate3d(${Math.sin(t * 0.06) * 6}%, ${
          Math.cos(t * 0.045) * 6
        }%, 0)`;
      }
      if (!rm) {
        aurBlobs.forEach((a, i) => {
          a.style.transform = `translate(${Math.sin(t * 0.08 + i * 2.1) * W * 0.12}px,${
            Math.cos(t * 0.06 + i * 1.3) * H * 0.12
          }px)`;
        });
      }

      // ── hero ───────────────────────────────────────────────────────────────
      let heroRect: DOMRect | null = null;
      if (hero) {
        heroRect = hero.getBoundingClientRect();
        const k = clamp01(-heroRect.top / heroRect.height);
        if (heroVideo) heroVideo.style.transform = `scale(${1 + k * 0.18})`;
        if (heroContent) {
          heroContent.style.transform = `translateY(${-k * 120}px)`;
          heroContent.style.opacity = String(1 - k * 1.3);
        }
      }

      // Some browsers silently stall a muted autoplaying video; nudge it.
      if (
        heroVideo &&
        !heroVideo.paused &&
        heroVideo.readyState >= 2 &&
        heroRect &&
        heroRect.bottom > 0
      ) {
        if (Math.abs(heroVideo.currentTime - hvLastTime) < 0.0001) {
          hvStall += dt;
          if (hvStall > 0.8) {
            hvStall = 0;
            try {
              heroVideo.currentTime = Math.min(
                heroVideo.duration - 0.6,
                heroVideo.currentTime + 0.05
              );
            } catch {
              /* duration not known yet */
            }
            void heroVideo.play().catch(() => {});
          }
        } else {
          hvStall = 0;
        }
        hvLastTime = heroVideo.currentTime;
      }

      if (heroCards.length && heroRect && heroRect.bottom > 0) {
        const hk = clamp01(-heroRect.top / H);
        heroCards.forEach((el, i) => {
          const d = [1, 1.6, 1.25][i] ?? 1;
          el.style.transform =
            `translate3d(${mouse.x * 18 * d}px,${
              mouse.y * 12 * d + (rm ? 0 : Math.sin(t * 0.9 + i * 2) * 10) - hk * 180 * d
            }px,0) rotateY(${mouse.x * 12}deg) rotateX(${-mouse.y * 9}deg)`;
          el.style.opacity = String(1 - hk * 1.5);
        });
      }

      // ── marquee ────────────────────────────────────────────────────────────
      const marqueeVisible = (() => {
        if (!marquee) return false;
        const r = marquee.getBoundingClientRect();
        return r.bottom > 0 && r.top < H;
      })();
      if (marquee && !rm && marqueeVisible) {
        if (marquee.dataset.paused !== '1') mqX -= dt * 42;
        const half = marquee.scrollWidth / 2;
        if (half > 0 && -mqX >= half) mqX += half;
        marquee.style.transform = `translateX(${mqX}px)`;
      }

      // ── problem: scattered complaints converge, then the answer ────────────
      // Gated on visibility: this block writes ~11 inline styles, and without
      // the gate it ran on every frame of the whole page scroll.
      const problemRect = problem?.getBoundingClientRect();
      if (problem && problemRect && problemRect.bottom > 0 && problemRect.top < H) {
        const p = clamp01(-problemRect.top / Math.max(1, problemRect.height - H));
        const sc =
          W < 768
            ? [
                [-0.12, -0.33, -6],
                [0.14, -0.22, 5],
                [-0.1, 0.24, 4],
                [0.12, 0.35, -5],
              ]
            : [
                [-0.3, -0.27, -6],
                [0.29, -0.21, 5],
                [-0.27, 0.26, 4],
                [0.31, 0.23, -5],
              ];
        const c = clamp01((p - 0.22) / 0.33);
        const e = easeOut(c);
        quoteCards.forEach((el, i) => {
          const s = sc[i] ?? sc[0];
          const fl = rm ? 0 : Math.sin(t * 0.9 + i * 1.7) * 9 * (1 - e);
          el.style.transform = `translate(${s[0] * W * (1 - e)}px,${
            s[1] * H * (1 - e) + fl
          }px) rotate(${s[2] * (1 - e)}deg) scale(${1 - 0.55 * e})`;
          el.style.opacity = String(1 - clamp01((c - 0.55) / 0.45));
        });
        if (probA) {
          const o = 1 - clamp01((p - 0.3) / 0.16);
          probA.style.opacity = String(o);
          probA.style.transform = `scale(${0.94 + 0.06 * o})`;
        }
        if (probB) {
          const o = clamp01((p - 0.5) / 0.14);
          probB.style.opacity = String(o);
          probB.style.transform = `translateY(${(1 - o) * 30}px)`;
        }
        flowPills.forEach((el, i) => {
          el.style.opacity = p > 0.6 + i * 0.065 ? '1' : '0.3';
        });
      }

      // ── journey: a document travels its whole lifecycle ────────────────────
      // Same gate. This is the heaviest block on the page: ~17 style writes,
      // including 10 confetti bits and an SVG point lookup.
      const journeyRect = journey?.getBoundingClientRect();
      if (journey && journeyRect && journeyRect.bottom > 0 && journeyRect.top < H) {
        const p = clamp01(-journeyRect.top / Math.max(1, journeyRect.height - H));
        const idx = Math.min(4, Math.floor(p * 5));
        if (idx !== stageRef.current) {
          stageRef.current = idx;
          onStage(idx);
        }

        if (jStage && jStage.clientHeight > 0) {
          const sw = jStage.clientWidth;
          const sh = jStage.clientHeight;
          const jk = Math.max(0.45, Math.min(1.1, sh / 500, (sw * (sw < 700 ? 0.6 : 0.54)) / 340));
          const a4 = easeOut(clamp01((p - 0.82) / 0.13));
          const mo = rm ? 0 : 1;

          if (docRig) {
            docRig.style.transform =
              `translateY(${a4 * sh * 0.2}px) scale(${jk * (1 - a4 * 0.4)}) ` +
              `rotateX(${(8 - p * 4) * mo + a4 * 22}deg) ` +
              `rotateY(${(-18 + p * 36) * mo * (1 - a4)}deg) ` +
              `translateY(${Math.sin(t * 1.1) * 6 * mo * (1 - a4)}px)`;
          }
          if (drawer) {
            drawer.style.opacity = String(clamp01(a4 * 1.6));
            drawer.style.transform = `translate(-50%,${(1 - a4) * 40}px)`;
          }

          const fr = clamp01((p - 0.1) / 0.76);
          if (route) route.style.strokeDashoffset = String(-t * 18);
          if (route && packet) {
            const L = route.getTotalLength();
            const pt = route.getPointAtLength(L * fr);
            packet.style.transform = `translate(${(pt.x / 100) * sw}px,${
              (pt.y / 100) * sh
            }px) translate(-50%,-50%) rotate(${Math.sin(t * 3) * 8}deg)`;
            packet.style.opacity = fr > 0.002 && fr < 0.998 ? '1' : '0';
          }

          // Form fields type themselves in, left to right.
          const lp0 = clamp01((p * 5) / 0.8);
          fieldValues.forEach((el, i) => {
            const k = clamp01(lp0 * 3 - i);
            el.style.clipPath = `inset(0 ${100 - k * 100}% 0 0)`;
          });

          // Confetti of paper bits at the moment of the decision.
          const b = clamp01((p - 0.6) / 0.09);
          bits.forEach((el, i) => {
            const a = (i / bits.length) * Math.PI * 2 + 0.3;
            const d = 40 + (i % 3) * 26;
            el.style.transform = `translate(${Math.cos(a) * d * b}px,${
              Math.sin(a) * d * b + b * b * 40
            }px) rotate(${b * (i % 2 ? 240 : -200)}deg)`;
            el.style.opacity = b > 0 && b < 1 ? String(1 - b * 0.9) : '0';
          });
        }

        if (rail) rail.style.transform = `scaleY(${p})`;
      }

      // ── featured video panel grows into place ──────────────────────────────
      const featRect = feat?.getBoundingClientRect();
      if (feat && featRect && featRect.bottom > -200 && featRect.top < H + 200) {
        const r = featRect;
        const k = easeOut(clamp01((H - r.top) / (H * 0.85)));
        const scale = 0.86 + 0.14 * k;
        feat.style.transform = `scale(${scale})`;
        feat.style.borderRadius = `${48 - 20 * k}px`;
        // Published so the small caption labels can divide it back out. Without
        // this the 13px eyebrow renders at 11.18px while the panel is scaled.
        feat.style.setProperty('--lp-feat-scale', String(scale));
      }

      // ── tenancy: three workspaces separate, walls rise between them ────────
      if (tenRig?.parentElement) {
        const r = tenRig.parentElement.getBoundingClientRect();
        if (r.bottom > -100 && r.top < H + 100) {
          const k = easeOut(clamp01((H - r.top) / (H * 0.85)));
          const u = Math.max(0.4, Math.min(1, r.width / 1040));
          const DX = 320;
          const kw = clamp01((k - 0.55) / 0.45);

          tenRig.style.transform = `scale(${u}) rotateX(58deg) rotateZ(${
            rm ? 0 : Math.sin(t * 0.25) * 2.5
          }deg)`;

          planes.forEach((el, i) => {
            el.style.transform = `translate3d(${(i - 1) * DX * k}px,0,${
              i * 16 * (1 - k) + (rm ? 0 : Math.sin(t * 1.1 + i * 1.8) * 9 * k)
            }px)`;
            el.querySelectorAll<HTMLElement>('[data-chip]').forEach((chip, j) => {
              chip.style.transform = `translate3d(${
                20 + ((Math.sin(t * 0.6 + j * 2.1 + i) + 1) / 2) * 180
              }px,${30 + ((Math.cos(t * 0.45 + j * 1.4 + i * 2) + 1) / 2) * 90}px,4px)`;
            });
          });

          walls.forEach((el, i) => {
            el.style.transform = `translate3d(${
              (i === 0 ? -0.5 : 0.5) * DX * k
            }px,-95px,0) rotateY(-90deg) scaleX(${Math.max(0.001, kw)})`;
            el.style.opacity = String(kw);
          });
        }
      }

      // ── particle field ─────────────────────────────────────────────────────
      if (wave) {
        wave.frame({
          t,
          scroll: pageProg,
          mouseX: mouse.x,
          mouseY: mouse.y,
          reducedMotion: rm,
          skip: !!heroRect && heroRect.bottom > H * 0.95,
        });
      }

      // ── Docky reading the knowledge base ───────────────────────────────────
      if (aiStage) {
        const ar = aiStage.getBoundingClientRect();
        if (ar.bottom > -100 && ar.top < H + 100) {
          const sw = aiStage.clientWidth;
          const sh = aiStage.clientHeight;
          const cx = sw / 2;
          const cy = sh / 2 + 10;
          const R = Math.min(sw * 0.39, 280);
          const ry = R * 0.36;

          const { aiPhase, aiQ } = inputsRef.current;
          const act = aiSrc[aiQ];
          const focus = aiPhase === 'search' || aiPhase === 'answer';

          // The orbit slows almost to a stop while Docky is reading.
          orbSp += ((focus ? 0.03 : 0.22) - orbSp) * 0.05;
          if (!rm) orbA += dt * orbSp;

          let ax = cx;
          let ay = cy;
          orbs.forEach((el, i) => {
            const a = orbA + (i * Math.PI * 2) / orbs.length;
            const x = Math.cos(a) * R;
            const y = Math.sin(a) * ry;
            const depth = (Math.sin(a) + 1) / 2;
            const on = focus && i === act;
            el.style.transform = `translate(${cx + x}px,${cy + y}px) translate(-50%,-50%) scale(${
              0.72 + 0.32 * depth + (on ? 0.16 : 0)
            })`;
            el.style.zIndex = String(Math.round(depth * 10));
            el.style.opacity = String(on ? 1 : 0.5 + 0.5 * depth);
            el.dataset.active = on ? '1' : '0';
            if (i === act) {
              ax = cx + x;
              ay = cy + y;
            }
          });

          const fy = rm ? 0 : Math.sin(t * 1.4) * 8;
          if (docky) {
            docky.style.transform = `translate(${cx}px,${cy + fy}px) translate(-50%,-50%) rotate(${
              rm ? 0 : Math.sin(t * 0.9) * 3
            }deg)`;
          }
          if (beam) {
            beam.setAttribute('x1', String(ax));
            beam.setAttribute('y1', String(ay));
            beam.setAttribute('x2', String(cx));
            beam.setAttribute('y2', String(cy + fy));
            beam.style.opacity = focus ? '1' : '0';
            beam.style.strokeDashoffset = String(-t * 60);
          }

          // Eyes follow the source being read, or the pointer when idle.
          let lx = 0;
          let ly = 0;
          if (focus) {
            lx = ax - cx;
            ly = ay - cy;
          } else if (mouse.cx >= 0) {
            lx = mouse.cx - (ar.left + cx);
            ly = mouse.cy - (ar.top + cy);
          }
          const ln = Math.hypot(lx, ly) || 1;
          const m = Math.min(1, ln / 160) * 5;
          for (const pup of [pupL, pupR]) {
            if (pup) pup.style.transform = `translate(${(lx / ln) * m}px,${(ly / ln) * m}px)`;
          }

          const blink = !rm && t % 4.3 < 0.13 ? 0.1 : 1;
          for (const eye of [eyeL, eyeR]) {
            if (eye) eye.style.transform = `scaleY(${blink})`;
          }

          if (kbRing) {
            kbRing.style.width = `${R * 2 + 170}px`;
            kbRing.style.height = `${ry * 2 + 120}px`;
          }
        }
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(vraf);
      clearTimeout(vfb);
      timers.forEach(clearTimeout);
      window.removeEventListener('mousemove', onMouse);
      vidIO.disconnect();
      themeObserver.disconnect();
      videoCleanup?.();
      wave?.dispose();
    };
    // Mounts once with the page; every changing value is read through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export default useV4Engine;
