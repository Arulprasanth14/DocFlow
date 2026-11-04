import React, { useEffect, useRef, useState } from 'react';
import { useV4Engine, type EngineInputs } from './v4/engine';
import { useRevealFx } from './v4/useRevealFx';
import { useV4Cursor } from './v4/useV4Cursor';
import { useAiCycle } from './v4/useAiCycle';
import { ink } from './v4/tokens';

import { Nav } from './v4/sections/Nav';
import { Hero } from './v4/sections/Hero';
import { Marquee } from './v4/sections/Marquee';
import { Problem } from './v4/sections/Problem';
import { PainPoints } from './v4/sections/PainPoints';
import { Journey } from './v4/sections/Journey';
import { FeaturedVideo } from './v4/sections/FeaturedVideo';
import { DocTypes } from './v4/sections/DocTypes';
import { Roles } from './v4/sections/Roles';
import { Approvals } from './v4/sections/Approvals';
import { Signatures } from './v4/sections/Signatures';
import { Docky } from './v4/sections/Docky';
import { Analytics } from './v4/sections/Analytics';
import { Tenants } from './v4/sections/Tenants';
import { Comparison } from './v4/sections/Comparison';
import { Trust } from './v4/sections/Trust';
import { Faq } from './v4/sections/Faq';
import { FinalCta } from './v4/sections/FinalCta';
import { Footer } from './v4/sections/Footer';

import './v4.css';

const GRAIN =
  "url(\"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

/** The four drifting aurora blobs behind the whole page. */
const BLOBS = [
  { left: '-12vw', top: '5svh', size: '62vw', c: 'var(--lp-aur-1)' },
  { right: '-16vw', top: '30svh', size: '58vw', c: 'var(--lp-aur-2)' },
  { left: '20vw', bottom: '-25svh', size: '55vw', c: 'var(--lp-aur-3)' },
  { right: '5vw', top: '-15svh', size: '40vw', c: 'var(--lp-aur-4)' },
];

export interface LandingPageProps {
  /** Replace the system pointer with the branded cursor on fine-pointer devices. */
  customCursor?: boolean;
  /** Film-grain overlay. */
  grain?: boolean;
}

/**
 * DocFlow landing page — "DocFlow Landing v4".
 *
 * Ported from the Claude Design file of the same name. The page is a stack of
 * nineteen presentational sections over three fixed background layers (aurora,
 * particle field, grain); all scroll-linked motion lives in `v4/engine.ts`.
 */
export const LandingPage: React.FC<LandingPageProps> = ({
  customCursor = false,
  grain = true,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const aiSectionRef = useRef<HTMLDivElement>(null);

  const [size, setSize] = useState({ w: 1440, h: 900 });
  const [stage, setStage] = useState(0);
  // Pessimistic on purpose: the media styling is white-on-dark, so assuming a
  // video that never arrives would leave white text on a pale page. The hero
  // renders light and upgrades once the video is genuinely playing.
  const [videoOk, setVideoOk] = useState(false);

  useEffect(() => {
    document.title = 'DocFlow — Paperwork, minus the paper chase';
  }, []);

  // Anchor links should glide. Scoped to this page's lifetime so app routes
  // keep their own scrolling behaviour.
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.scrollBehavior;
    html.style.scrollBehavior = 'smooth';
    return () => {
      html.style.scrollBehavior = prev;
    };
  }, []);

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const { ai, ask } = useAiCycle(aiSectionRef);

  // The engine reads these every frame; a ref keeps it off the render path.
  const inputsRef = useRef<EngineInputs>({ aiPhase: 'idle', aiQ: 0 });
  inputsRef.current = { aiPhase: ai.phase, aiQ: ai.q };

  useV4Engine({
    rootRef,
    canvasRef,
    inputsRef,
    onStage: setStage,
    onVideoUnavailable: () => setVideoOk(false),
    onVideoReady: () => setVideoOk(true),
  });
  useRevealFx(rootRef);
  useV4Cursor(rootRef, ringRef, dotRef, customCursor);

  const wide = size.w >= 1080;

  return (
    <div ref={rootRef} className="landing-scope">
      {/* scroll progress */}
      <div
        data-el="bar"
        aria-hidden="true"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          zIndex: 80,
          transformOrigin: '0 50%',
          transform: 'scaleX(0)',
          background: 'var(--lp-grad-bar)',
        }}
      />

      {/* aurora field */}
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 0,
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      >
        {/* Oversized and moved with translate3d rather than background-position.
            Animating background-position repainted this full-viewport gradient
            on every frame; a transform is composited and costs nothing. The
            -20% inset hides the edges as it drifts. */}
        <div
          data-el="aur0"
          style={{
            position: 'absolute',
            inset: '-20%',
            background: 'var(--lp-aur-base)',
            backgroundSize: '400% 400%',
            willChange: 'transform',
          }}
        />
        {BLOBS.map((b, i) => (
          <div
            key={i}
            data-aur=""
            style={{
              position: 'absolute',
              left: b.left,
              right: b.right,
              top: b.top,
              bottom: b.bottom,
              width: b.size,
              height: b.size,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${b.c}, transparent 62%)`,
              willChange: 'transform',
            }}
          />
        ))}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `radial-gradient(${ink(0.07)} 1px, transparent 1px)`,
            backgroundSize: '28px 28px',
            WebkitMaskImage: 'radial-gradient(ellipse at center, #000 30%, transparent 80%)',
            maskImage: 'radial-gradient(ellipse at center, #000 30%, transparent 80%)',
          }}
        />
      </div>

      {/* particle field */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          width: '100%',
          height: '100%',
          zIndex: 0,
          pointerEvents: 'none',
        }}
      />

      {grain && (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 70,
            pointerEvents: 'none',
            opacity: 'var(--lp-grain-opacity)',
            backgroundImage: GRAIN,
          }}
        />
      )}

      {/* custom cursor — hidden until the first pointer move positions it */}
      {customCursor && (
        <>
          <div
            ref={ringRef}
            aria-hidden="true"
            style={{
              display: 'none',
              position: 'fixed',
              left: 0,
              top: 0,
              width: 40,
              height: 40,
              borderRadius: '50%',
              border: `1px solid ${ink(0.45)}`,
              zIndex: 90,
              pointerEvents: 'none',
              // No backdrop-filter here. It moves every frame, so the blur
              // re-sampled whatever it passed over continuously — an invisible 2px
              // effect on a 40px ring, paid for on every frame of every scroll.
              willChange: 'transform',
              transition: 'background .25s, border-color .25s, opacity .25s',
            }}
          />
          <div
            ref={dotRef}
            aria-hidden="true"
            style={{
              display: 'none',
              position: 'fixed',
              left: 0,
              top: 0,
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--lp-cursor-dot)',
              zIndex: 91,
              pointerEvents: 'none',
              transition: 'opacity .2s',
            }}
          />
        </>
      )}

      <Nav wide={wide} />

      <main>
        <Hero showCards={size.w >= 1100} videoOk={videoOk} />
        <Marquee />
        <Problem />
        <PainPoints />
        <Journey stage={stage} w={size.w} h={size.h} />
        <FeaturedVideo videoOk={videoOk} />
        <DocTypes />
        <Roles />
        <Approvals />
        <Signatures />
        <div ref={aiSectionRef}>
          <Docky ai={ai} ask={ask} />
        </div>
        <Analytics />
        <Tenants />
        <Comparison />
        <Trust />
        <Faq />
        <FinalCta videoOk={videoOk} />
      </main>

      <Footer />

      <p className="lp-sr-only">
        DocFlow moves documents from draft to approval to archive. Decorative animation on this page
        is not required to read it; every section is described in text above.
      </p>
    </div>
  );
};

export default LandingPage;
