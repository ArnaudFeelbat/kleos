import { describe, expect, it } from 'vitest';
import { kleosReleaseUrl, parseRelease, releaseToUpdate } from './release';

/** Trimmed from a real GitHub "latest release" answer. */
function release(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://api.github.com/repos/ArnaudFeelbat/kleos/releases/1',
    html_url: 'https://github.com/ArnaudFeelbat/kleos/releases/tag/v0.5.1',
    tag_name: 'v0.5.1',
    name: 'Kleos 0.5.1',
    draft: false,
    prerelease: false,
    published_at: '2026-12-01T09:30:00Z',
    body: '## 0.5.1\n\n- Corrige le tri.',
    assets: [
      {
        name: 'Kleos-0.5.1-arm64.dmg.sha256',
        browser_download_url:
          'https://github.com/ArnaudFeelbat/kleos/releases/download/v0.5.1/Kleos-0.5.1-arm64.dmg.sha256',
      },
      {
        name: 'Kleos-0.5.1-arm64.dmg',
        browser_download_url: 'https://github.com/ArnaudFeelbat/kleos/releases/download/v0.5.1/Kleos-0.5.1-arm64.dmg',
      },
    ],
    ...overrides,
  };
}

describe('releaseToUpdate', () => {
  it('offers a newer release with its page, notes, date and DMG', () => {
    expect(releaseToUpdate(release(), '0.5.0')).toEqual({
      version: '0.5.1',
      url: 'https://github.com/ArnaudFeelbat/kleos/releases/tag/v0.5.1',
      notes: '## 0.5.1\n\n- Corrige le tri.',
      publishedAt: '2026-12-01T09:30:00Z',
      dmgUrl: 'https://github.com/ArnaudFeelbat/kleos/releases/download/v0.5.1/Kleos-0.5.1-arm64.dmg',
    });
  });

  it('offers nothing when the release is the running version or older', () => {
    expect(releaseToUpdate(release(), '0.5.1')).toBeNull();
    expect(releaseToUpdate(release(), '0.6.0')).toBeNull();
    expect(releaseToUpdate(release({ tag_name: 'v0.5.0' }), '0.5.0')).toBeNull();
  });

  it('compares numerically and treats a release as newer than its pre-releases', () => {
    expect(releaseToUpdate(release({ tag_name: 'v0.10.0' }), '0.9.3')?.version).toBe('0.10.0');
    expect(releaseToUpdate(release({ tag_name: '1.0.0' }), '1.0.0-beta.2')?.version).toBe('1.0.0');
  });

  it('never offers a draft or a pre-release', () => {
    expect(releaseToUpdate(release({ draft: true }), '0.5.0')).toBeNull();
    expect(releaseToUpdate(release({ prerelease: true, tag_name: 'v0.6.0-beta.1' }), '0.5.0')).toBeNull();
  });

  it('keeps the release without a DMG and without notes', () => {
    const info = releaseToUpdate(release({ assets: [], body: null }), '0.5.0');
    expect(info?.dmgUrl).toBeNull();
    expect(info?.notes).toBe('');
  });

  it('ignores an Intel or universal DMG', () => {
    const assets = [{ name: 'Kleos-0.5.1.dmg', browser_download_url: 'https://github.com/x/Kleos-0.5.1.dmg' }];
    expect(releaseToUpdate(release({ assets }), '0.5.0')?.dmgUrl).toBeNull();
  });

  it('returns null for a malformed answer', () => {
    expect(releaseToUpdate(null, '0.5.0')).toBeNull();
    expect(releaseToUpdate('Not Found', '0.5.0')).toBeNull();
    expect(releaseToUpdate({ message: 'Not Found' }, '0.5.0')).toBeNull();
    expect(releaseToUpdate(release({ tag_name: 'latest' }), '0.5.0')).toBeNull();
    expect(releaseToUpdate(release({ html_url: 42 }), '0.5.0')).toBeNull();
    expect(releaseToUpdate(release({ published_at: null }), '0.5.0')).toBeNull();
  });
});

describe('kleosReleaseUrl', () => {
  it('accepts release pages and downloads of the Kleos repository', () => {
    const page = 'https://github.com/ArnaudFeelbat/kleos/releases/tag/v0.5.1';
    const dmg = 'https://github.com/ArnaudFeelbat/kleos/releases/download/v0.5.1/Kleos-0.5.1-arm64.dmg';
    expect(kleosReleaseUrl(page)).toBe(page);
    expect(kleosReleaseUrl(dmg)).toBe(dmg);
  });

  it('refuses every other URL, including ones that only look like the repository', () => {
    expect(kleosReleaseUrl('https://github.com/ArnaudFeelbat/kleos')).toBeNull();
    expect(kleosReleaseUrl('https://github.com/ArnaudFeelbat/kleos-evil/releases')).toBeNull();
    expect(kleosReleaseUrl('https://github.com/ArnaudFeelbat/kleos/../other/releases')).toBeNull();
    expect(kleosReleaseUrl('https://github.com/ArnaudFeelbat/kleos/%2e%2e/other')).toBeNull();
    expect(kleosReleaseUrl('http://github.com/ArnaudFeelbat/kleos/releases')).toBeNull();
    expect(kleosReleaseUrl('file:///Applications/Kleos.app')).toBeNull();
    expect(kleosReleaseUrl(42)).toBeNull();
  });
});

describe('parseRelease', () => {
  it('reads a release whatever its version, to tell "up to date" from "unreadable"', () => {
    expect(parseRelease(release({ tag_name: 'v0.1.0' }))?.version).toBe('0.1.0');
    expect(parseRelease({ message: 'API rate limit exceeded' })).toBeNull();
  });
});
