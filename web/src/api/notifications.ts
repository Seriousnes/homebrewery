// Site notifications (banners) shown to everyone.
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api, type CallOptions, unwrap } from './client';
import type { ApiError } from './errors';
import type { QueryOverrides } from './hookOptions';
import { queryKeys } from './keys';
import type { NotificationInfo } from './types';

/** Notifications active now, oldest start first. Bodies are plain text. */
export async function fetchActiveNotifications({ client = api, signal }: CallOptions = {}): Promise<NotificationInfo[]> {
  return unwrap(client.GET('/api/notifications/active', { signal }), { method: 'GET', url: '/api/notifications/active' });
}

export const notificationQueries = {
  /** Background data: failures stay silent (no toast); the banner simply doesn't show. */
  active: () =>
    queryOptions<NotificationInfo[], ApiError>({
      queryKey: queryKeys.notifications.active(),
      queryFn: ({ signal }) => fetchActiveNotifications({ signal }),
      staleTime: 5 * 60_000,
      meta: { errorPolicy: 'manual' },
    }),
};

export function useActiveNotifications(overrides?: QueryOverrides<NotificationInfo[]>) {
  return useQuery({ ...notificationQueries.active(), ...overrides });
}
