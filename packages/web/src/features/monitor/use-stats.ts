import { statsIntervals, type StatsKind } from '@kleos/shared';
import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from '@/features/workspace/context';
import { api, queryKeys } from '@/lib/api';

/**
 * One monitoring panel's data, polled at the spec interval only while `live` (Monitor tab active,
 * window visible, not paused). When not live the query is disabled, so nothing is fetched.
 */
export function useStats<K extends StatsKind>(kind: K, live: boolean) {
  const { sid } = useWorkspace();
  return useQuery({
    queryKey: queryKeys.stats(sid, kind),
    queryFn: () => api.stats(sid, kind),
    enabled: live,
    refetchInterval: live ? statsIntervals[kind] : false,
    refetchIntervalInBackground: false,
    // A snapshot is stale as soon as the next poll is due.
    staleTime: statsIntervals[kind],
  });
}

/** "5 s", "30 s" */
export function intervalLabel(kind: StatsKind): string {
  return `${statsIntervals[kind] / 1000} s`;
}
