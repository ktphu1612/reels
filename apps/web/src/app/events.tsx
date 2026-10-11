import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { dedupeJobEvents, type QueueEvent } from '../lib/queue-events';
import { queryKeys } from './query-hooks';

const EVENT_TYPES = [
  'job.queued',
  'job.running',
  'job.progress',
  'job.succeeded',
  'job.failed',
  'job.cancelled',
  'job.retried',
  'job.recovered',
  'job.cancel-requested',
] as const;

const RealtimeContext = createContext<{ connected: boolean; lastEventId: string | undefined } | null>(null);

export function RealtimeProvider({ children }: { readonly children: ReactNode }) {
  const status = useEventInvalidation();
  return <RealtimeContext.Provider value={status}>{children}</RealtimeContext.Provider>;
}
export function useRealtimeStatus(): { connected: boolean; lastEventId: string | undefined } {
  return useContext(RealtimeContext) ?? { connected: false, lastEventId: undefined };
}

export function useEventInvalidation(): { connected: boolean; lastEventId: string | undefined } {
  const queryClient = useQueryClient();
  const seenIds = useRef<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastEventId, setLastEventId] = useState<string>();

  useEffect(() => {
    const EventSourceCtor = typeof window !== 'undefined' ? window.EventSource : undefined;
    if (!EventSourceCtor) return undefined;
    const source = new EventSourceCtor('/api/events');
    const handle = (event: MessageEvent<string>) => {
      let data: QueueEvent & { createdAt?: string };
      try {
        data = JSON.parse(event.data) as QueueEvent & { createdAt?: string };
      } catch {
        return;
      }
      const id = event.lastEventId;
      if (id) {
        if (seenIds.current.includes(id)) return;
        const current = [...seenIds.current, id].slice(-100);
        const unique = dedupeJobEvents(current.map((value) => ({ id: value })));
        seenIds.current = unique.map((value) => value.id);
        setLastEventId(id);
      }
      if (data.jobId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.job(data.jobId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      } else {
        void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      }
    };
    const listeners = EVENT_TYPES.map((type) => {
      source.addEventListener(type, handle);
      return type;
    });
    source.onmessage = handle;
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    return () => {
      for (const type of listeners) source.removeEventListener(type, handle);
      source.close();
    };
  }, [queryClient]);

  return { connected, lastEventId };
}
