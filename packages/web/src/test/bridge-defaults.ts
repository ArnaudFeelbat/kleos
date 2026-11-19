import type { UpdateState } from '@kleos/shared';

/** The update state a bridge mock answers with: no check made yet. */
export const idleUpdateState: UpdateState = {
  current: '0.5.0',
  status: 'idle',
  latest: null,
  checkedAt: null,
  error: null,
};
