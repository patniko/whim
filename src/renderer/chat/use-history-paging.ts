import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ChatMessage } from '../../shared/chat-types';
import { prependHistoryPage, type ChatHistoryPaging, type ChatHistorySource } from './transcript-layout';

export function useHistoryPaging(
  source: ChatHistorySource | undefined,
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
): ChatHistoryPaging | undefined {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const inFlight = useRef(false);
  const loadPage = source?.loadOlder;

  useEffect(() => {
    inFlight.current = false;
    setLoading(false);
    setError(undefined);
    return () => { generation.current++; };
  }, [loadPage]);

  const loadOlder = useCallback(async () => {
    if (!loadPage || inFlight.current) return;
    const epoch = generation.current;
    inFlight.current = true;
    setLoading(true);
    setError(undefined);
    try {
      const older = await loadPage();
      if (generation.current === epoch) {
        setMessages(current => prependHistoryPage(current, older));
      }
    } catch (failure) {
      if (generation.current === epoch) {
        setError(failure instanceof Error ? failure.message : 'Failed to load earlier history');
      }
    } finally {
      if (generation.current === epoch) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [loadPage, setMessages]);

  return source ? { hasOlder: source.hasOlder, loading, error, loadOlder } : undefined;
}
