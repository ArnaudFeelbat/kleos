import { parseRelease, releaseToUpdate, type UpdateChecks, type UpdateState } from '@kleos/shared';

/** GitHub's public "latest release" answer; drafts and pre-releases never appear there. */
export const latestReleaseUrl = 'https://api.github.com/repos/ArnaudFeelbat/kleos/releases/latest';

const timeoutMs = 10_000;
const hour = 60 * 60 * 1000;
const day = 24 * hour;
/** Timers fire a little after their mark: a check due "in 24 h" must not wait for the next hour. */
const slackMs = 60 * 1000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type UpdateChecker = {
  state(): UpdateState;
  /** Checks now, whatever the setting says (the user asked). Joins a check already running. */
  check(): Promise<UpdateState>;
  /**
   * Automatic checks for this setting: with `on`, a first check after `firstDelayMs`, then one a
   * day while Kleos runs (an hour after a failed one). `ask` and `off` stop them: no call leaves.
   */
  schedule(mode: UpdateChecks, firstDelayMs: number): void;
  dispose(): void;
};

/**
 * Update checks against GitHub Releases. One GET, no body, no cookies, nothing about the Mac
 * beyond the User-Agent's app version. `onState` hears every state change.
 */
export function createUpdateChecker(options: {
  currentVersion: string;
  url: string;
  fetch: Fetch;
  onState: (state: UpdateState) => void;
}): UpdateChecker {
  const { currentVersion, url, fetch, onState } = options;
  let state: UpdateState = { current: currentVersion, status: 'idle', latest: null, checkedAt: null, error: null };
  let running: Promise<UpdateState> | null = null;
  let lastAttempt = 0;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  function set(patch: Partial<UpdateState>): UpdateState {
    state = { ...state, ...patch };
    onState(state);
    return state;
  }

  async function fetchLatest(): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The race also bounds the body read, and does not rely on the fetch honouring the signal.
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CheckError('GitHub did not answer within 10 seconds.'));
      }, timeoutMs);
    });
    const request = async () => {
      const response = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Kleos/${currentVersion}` },
        credentials: 'omit',
        signal: controller.signal,
      });
      if (response.status === 404) throw new CheckError('No Kleos release is published yet.');
      if (response.status === 403 || response.status === 429) {
        throw new CheckError('GitHub is limiting requests right now. Try again in an hour.');
      }
      if (!response.ok) throw new CheckError(`GitHub answered with an error (HTTP ${response.status}).`);
      return (await response.json()) as unknown;
    };
    try {
      return await Promise.race([request(), timeout]);
    } catch (err) {
      if (err instanceof CheckError) throw err;
      if (controller.signal.aborted) throw new CheckError('GitHub did not answer within 10 seconds.');
      if (err instanceof SyntaxError) throw new CheckError('GitHub’s answer could not be read.');
      throw new CheckError('Kleos could not reach GitHub. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
    }
  }

  async function run(): Promise<UpdateState> {
    lastAttempt = Date.now();
    // `latest` stays while checking, so a found update does not flicker away.
    set({ status: 'checking', error: null });
    try {
      const json = await fetchLatest();
      if (!parseRelease(json)) throw new CheckError('GitHub’s answer could not be read.');
      const latest = releaseToUpdate(json, currentVersion);
      return set({ status: latest ? 'available' : 'current', latest, checkedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[kleos] update check failed', err);
      return set({ status: 'error', error: err instanceof CheckError ? err.message : 'The update check failed.' });
    }
  }

  function check(): Promise<UpdateState> {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  }

  function stop(): void {
    if (firstTimer) clearTimeout(firstTimer);
    if (ticker) clearInterval(ticker);
    firstTimer = null;
    ticker = null;
  }

  /** Hourly rather than one 24 h timer, so a Mac that slept through the mark still checks on waking. */
  function tick(): void {
    const due = state.status === 'error' ? hour : day;
    if (Date.now() - lastAttempt >= due - slackMs) void check();
  }

  return {
    state: () => state,
    check,
    schedule(mode, firstDelayMs) {
      stop();
      if (mode !== 'on') return;
      firstTimer = setTimeout(() => {
        firstTimer = null;
        void check();
        ticker = setInterval(tick, hour);
      }, firstDelayMs);
    },
    dispose: stop,
  };
}

/** A failure worded for the Settings window. */
class CheckError extends Error {}
