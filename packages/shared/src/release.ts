import { z } from 'zod';
import { compareVersions, type UpdateInfo } from './settings';

/**
 * Reading GitHub's "latest release" answer (0.5). Pure, so the main process only fetches and
 * the decisions stay tested here.
 * https://docs.github.com/en/rest/releases/releases#get-the-latest-release
 */

/** The part of GitHub's release object Kleos reads; everything else is ignored. */
const GithubRelease = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  body: z.string().nullish(),
  published_at: z.string(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })).default([]),
});

const releaseVersion = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Kleos ships one Apple-silicon DMG per release, named by electron-builder `Kleos-<version>-arm64.dmg`. */
const dmgSuffix = '-arm64.dmg';

/** The release described by GitHub's JSON, or null when the answer is not a readable release. */
export function parseRelease(json: unknown): UpdateInfo | null {
  const parsed = GithubRelease.safeParse(json);
  if (!parsed.success) return null;
  const release = parsed.data;
  const version = releaseVersion.exec(release.tag_name.trim())?.[1];
  if (!version || !release.html_url) return null;
  const dmg = release.assets.find((asset) => asset.name.endsWith(dmgSuffix));
  return {
    version,
    url: release.html_url,
    notes: release.body ?? '',
    publishedAt: release.published_at,
    dmgUrl: dmg?.browser_download_url ?? null,
  };
}

/** Release pages and release downloads both live under the repository's path on github.com. */
const kleosRepoPrefix = 'https://github.com/ArnaudFeelbat/kleos/';

/**
 * The URL to open in the browser for a release page or DMG download, or null for anything that
 * is not on Kleos's GitHub repository (after normalisation, so `kleos/../elsewhere` is refused).
 */
export function kleosReleaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(kleosRepoPrefix)) return null;
  try {
    const href = new URL(value).href;
    return href.startsWith(kleosRepoPrefix) ? href : null;
  } catch {
    return null;
  }
}

/**
 * The update to offer, or null when the release is not newer than `currentVersion`, is a draft
 * or pre-release (never offered), or the answer is malformed.
 */
export function releaseToUpdate(json: unknown, currentVersion: string): UpdateInfo | null {
  const info = parseRelease(json);
  if (!info) return null;
  const { draft, prerelease } = json as { draft?: unknown; prerelease?: unknown };
  if (draft === true || prerelease === true) return null;
  return compareVersions(info.version, currentVersion) > 0 ? info : null;
}
