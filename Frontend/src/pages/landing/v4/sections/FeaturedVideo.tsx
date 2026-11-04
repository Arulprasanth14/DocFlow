import React from 'react';
import { HERO_VIDEO } from '../data';
import { ArrowUpRight } from '../ui';
import { ink, surface } from '../tokens';

/**
 * A worked example, framed in a panel that grows from 86% to full size and
 * loses its corner radius as it enters — the engine drives both.
 */
export const FeaturedVideo: React.FC<{ videoOk: boolean }> = ({ videoOk }) => {
  const onMedia = videoOk;
  const fg = onMedia ? '#fff' : ink(1);
  const fgSoft = onMedia ? 'rgb(255 255 255 / 0.8)' : ink(0.65);

  return (
    <section
      aria-labelledby="example-heading"
      style={{ position: 'relative', zIndex: 1, padding: '40px 24px 140px' }}
    >
      <div
        data-el="feat"
        style={{
          color: fg,
          position: 'relative',
          maxWidth: 1200,
          margin: '0 auto',
          borderRadius: 36,
          overflow: 'hidden',
          aspectRatio: '16 / 9',
          minHeight: 420,
          transformOrigin: '50% 0',
          boxShadow: '0 40px 120px rgb(56 189 248 / 0.12)',
          background: 'var(--lp-aur-base)',
        }}
      >
        {/* The fallback sits underneath and shows through if the video is
            missing. The video itself always mounts, so the engine's observer
            can find it on first pass. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(circle at 30% 20%, var(--lp-aur-1), transparent 60%),' +
              'radial-gradient(circle at 75% 70%, var(--lp-aur-2), transparent 62%)',
          }}
        />
        <video
          data-lazyvid=""
          src={HERO_VIDEO}
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
          tabIndex={-1}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: onMedia ? 1 : 0,
            transition: 'opacity .5s',
          }}
        />
        {onMedia && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              background:
                'linear-gradient(to top, rgb(0 0 0 / 0.85), rgb(0 0 0 / 0.2) 55%, rgb(0 0 0 / 0))',
            }}
          />
        )}

        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: 'clamp(16px, 3vw, 36px)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div
            className="liquid-glass"
            style={{
              borderRadius: 22,
              padding: '22px 24px',
              maxWidth: 480,
              background: onMedia ? 'rgb(0 0 0 / 0.4)' : surface(0.82),
            }}
          >
            <div
              className="lp-eyebrow"
              style={{ color: onMedia ? 'var(--lp-ramp-1)' : 'var(--lp-accent-deep)' }}
            >
              A real example
            </div>
            <div
              id="example-heading"
              style={{
                marginTop: 8,
                fontFamily: 'var(--lp-font-display)',
                fontSize: 'clamp(24px, 2.4vw, 32px)',
                lineHeight: 1.1,
              }}
            >
              A leave request, start to finish
            </div>
            <div data-fine-14="" style={{ marginTop: 6, color: fgSoft }}>
              Priya (Employee) → Karthik (Manager) → HR
            </div>
            <p style={{ margin: '12px 0 0', fontSize: 15, lineHeight: 1.6, color: fgSoft }}>
              Priya picks the Leave Request template, fills in her dates, and sends it. Her manager
              Karthik sees it in his queue, adds a comment, and approves. HR is next in line and can
              see Karthik’s approval and comment.
            </p>
          </div>

          <a
            href="#features"
            className="liquid-glass lp-hover-scale"
            style={{
              borderRadius: 999,
              padding: '13px 24px',
              fontSize: 15,
              background: onMedia ? 'rgb(0 0 0 / 0.35)' : surface(0.82),
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            Explore more
            <ArrowUpRight />
          </a>
        </div>
      </div>
    </section>
  );
};

export default FeaturedVideo;
