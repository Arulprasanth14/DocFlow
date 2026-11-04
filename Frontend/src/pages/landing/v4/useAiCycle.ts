import { useCallback, useEffect, useRef, useState } from 'react';
import { aiAnswers, prompts } from './data';

export type AiPhase = 'idle' | 'typing' | 'search' | 'answer' | 'done';

export interface AiState {
  phase: AiPhase;
  /** Index of the prompt being demonstrated. */
  q: number;
  /** The question, revealed character by character. */
  typed: string;
  /** The answer, revealed word by word. */
  answer: string;
}

/**
 * Drives the Docky demo: a question types itself, Docky looks up the one policy
 * document it needs, then the answer streams back with its source cited.
 *
 * Starts when the section first scrolls into view and then cycles through the
 * three prompts. Clicking a prompt jumps straight to it.
 *
 * The engine reads `phase` and `q` to aim the beam and slow the orbit, so both
 * are also mirrored into a ref by the caller.
 */
export function useAiCycle(sectionRef: React.RefObject<HTMLElement | null>) {
  const [state, setState] = useState<AiState>({ phase: 'idle', q: 0, typed: '', answer: '' });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const started = useRef(false);

  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  const at = (fn: () => void, ms: number) => timers.current.push(setTimeout(fn, ms));

  const run = useCallback((i: number) => {
    clear();
    const q = prompts[i];
    const words = aiAnswers[i].split(' ');
    setState({ phase: 'typing', q: i, typed: '', answer: '' });

    let chars = 0;
    let shown = 0;

    const stream = () => {
      shown++;
      setState((s) => ({ ...s, answer: words.slice(0, shown).join(' ') }));
      if (shown < words.length) at(stream, 55);
      else {
        setState((s) => ({ ...s, phase: 'done' }));
        at(() => run((i + 1) % prompts.length), 5500);
      }
    };

    const type = () => {
      chars++;
      setState((s) => ({ ...s, typed: q.slice(0, chars) }));
      if (chars < q.length) {
        at(type, 26);
        return;
      }
      at(() => {
        setState((s) => ({ ...s, phase: 'search' }));
        at(() => {
          setState((s) => ({ ...s, phase: 'answer' }));
          stream();
        }, 1600);
      }, 350);
    };

    at(type, 300);
  }, []);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && !started.current) {
          started.current = true;
          run(0);
        }
      },
      { threshold: 0.2 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clear();
    };
  }, [sectionRef, run]);

  return { ai: state, ask: run };
}

export default useAiCycle;
