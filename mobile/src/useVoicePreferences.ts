import { useCallback, useEffect, useRef, useState } from 'react';
import NativeAssist from '../specs/NativeAssist';

function preference(json: string): boolean {
  const value: unknown = JSON.parse(json);
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { readResponses?: unknown }).readResponses !== 'boolean'
  ) {
    throw new Error('Le réglage vocal enregistré est invalide.');
  }
  return (value as { readResponses: boolean }).readResponses;
}

/** Device-local preference, default on; a late read never overwrites a choice. */
export function useVoicePreferences() {
  const persistent =
    typeof NativeAssist?.getVoicePreferences === 'function' &&
    typeof NativeAssist?.setVoicePreferences === 'function';
  const [readResponses, setReadResponses] = useState(true);
  const [ready, setReady] = useState(!persistent);
  const [error, setError] = useState('');
  const version = useRef(0);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const captured = version.current;
    if (persistent) {
      NativeAssist!
        .getVoicePreferences()
        .then(json => {
          const saved = preference(json);
          if (mounted.current && version.current === captured)
            setReadResponses(saved);
        })
        .catch(() => {
          if (mounted.current && version.current === captured)
            setError('Le réglage vocal enregistré n’a pas pu être chargé.');
        })
        .finally(() => {
          if (mounted.current) setReady(true);
        });
    }
    return () => {
      mounted.current = false;
    };
  }, [persistent]);

  const change = useCallback(
    (enabled: boolean) => {
      const captured = ++version.current;
      setReadResponses(enabled);
      setError('');
      if (!persistent) return;
      writes.current = writes.current
        .catch(() => undefined)
        .then(async () => {
          const result = preference(
            await NativeAssist!.setVoicePreferences(enabled),
          );
          if (result !== enabled)
            throw new Error('Le réglage n’a pas été enregistré.');
        })
        .catch(() => {
          if (mounted.current && version.current === captured) {
            setError(
              'Le choix s’applique à cette session, mais son enregistrement a échoué.',
            );
          }
        });
    },
    [persistent],
  );
  return { readResponses, ready, error, change };
}
