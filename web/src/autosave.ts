// Saves text about a second after you stop typing, and once more when you leave.
import { useEffect, useRef, useState } from 'react';

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export function useAutosave(text: string, save: (text: string) => Promise<unknown>, enabled: boolean, delay = 800) {
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const saved = useRef<string | null>(null);
  const latest = useRef({ text, save });
  latest.current = { text, save };

  // The text as loaded counts as saved.
  useEffect(() => {
    if (enabled && saved.current === null) saved.current = text;
  }, [enabled, text]);

  const flush = () => {
    const { text: t, save: s } = latest.current;
    if (saved.current === null || t === saved.current) return;
    setState('saving');
    s(t).then(
      () => {
        saved.current = t;
        setError(null);
        setState(latest.current.text === t ? 'saved' : 'pending');
      },
      (e: Error) => {
        setError(e.message);
        setState('error');
      },
    );
  };

  useEffect(() => {
    if (!enabled || saved.current === null || text === saved.current) return;
    setState('pending');
    const timer = setTimeout(flush, delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, enabled, delay]);

  // Save on leaving the page or switching away from this text.
  useEffect(() => {
    addEventListener('beforeunload', flush);
    return () => {
      removeEventListener('beforeunload', flush);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Forget what was saved, e.g. when switching to another draft. */
  const reset = (loaded: string) => {
    saved.current = loaded;
    setState('idle');
  };

  return { state, error, reset };
}

export const saveLabel = (state: SaveState, error: string | null) =>
  ({ idle: '', pending: 'Unsaved…', saving: 'Saving…', saved: 'Saved', error: `Not saved: ${error}` })[state];
