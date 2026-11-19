import { z } from 'zod';

/**
 * App settings (0.5), owned by the main process and stored in preferences.json beside app.db.
 * Every window reads them through the bridge and is told when they change.
 */

export const pageSizes = [100, 200, 500, 1000] as const;
export const PageSize = z.union([z.literal(100), z.literal(200), z.literal(500), z.literal(1000)]);
export type PageSize = z.infer<typeof PageSize>;

/** Seconds; 0 means no timeout. Sent as statement_timeout when a session opens. */
export const queryTimeouts = [0, 30, 60, 300, 900] as const;
export const QueryTimeout = z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(300), z.literal(900)]);
export type QueryTimeout = z.infer<typeof QueryTimeout>;

/**
 * `ask`: not decided yet — Kleos makes no network call and offers the choice once.
 * `on`: checks GitHub Releases at launch and once a day. `off`: never (Check now still works).
 */
export const UpdateChecks = z.enum(['ask', 'on', 'off']);
export type UpdateChecks = z.infer<typeof UpdateChecks>;

export const Settings = z.object({
  appearance: z.enum(['system', 'light', 'dark']).default('system'),
  /** Rows per page in the Data tab. */
  pageSize: PageSize.default(200),
  /** Applies to sessions opened after the change. */
  queryTimeoutSeconds: QueryTimeout.default(0),
  updateChecks: UpdateChecks.default('ask'),
  /** A version the user chose to skip; its notice is not shown again. */
  skippedVersion: z.string().nullable().default(null),
});
export type Settings = z.infer<typeof Settings>;

export const defaultSettings: Settings = Settings.parse({});

/** A newer release found on GitHub. */
export const UpdateInfo = z.object({
  /** "0.5.1", without the leading v */
  version: z.string(),
  /** The release page (https://github.com/ArnaudFeelbat/kleos/releases/tag/v…). */
  url: z.string(),
  /** Release notes as Markdown (the French changelog section). */
  notes: z.string(),
  publishedAt: z.string(),
  /** The arm64 DMG's direct download URL, when the release has one. */
  dmgUrl: z.string().nullable(),
});
export type UpdateInfo = z.infer<typeof UpdateInfo>;

export const UpdateState = z.object({
  /** The running app's version. */
  current: z.string(),
  status: z.enum(['idle', 'checking', 'current', 'available', 'error']),
  /** Set when status is `available` (kept while a later check runs). */
  latest: UpdateInfo.nullable(),
  checkedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type UpdateState = z.infer<typeof UpdateState>;

/**
 * Compares two release versions ("0.5.0", "v0.10.1", "1.0.0-beta.2"): negative when a < b.
 * Numeric per part; a pre-release sorts before its release. Unparseable input sorts lowest.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i += 1) {
    const d = pa.nums[i]! - pb.nums[i]!;
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre.localeCompare(pb.pre, 'en', { numeric: true });
}
