// Renders the DMG window background from apps/desktop/build/dmg-background.html into
// dmg-background.png (660 × 440) and dmg-background@2x.png (1320 × 880) beside it, with headless
// Chrome. electron-builder combines the pair into one Retina-aware TIFF when it builds the DMG.
// Usage: node scripts/dmg-background.mjs  (set CHROME=<path> to use another Chrome binary)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const buildDir = fileURLToPath(new URL('../apps/desktop/build/', import.meta.url));
const source = pathToFileURL(join(buildDir, 'dmg-background.html')).href;
const [width, height] = [660, 440];

// A throwaway profile, so an open Chrome is neither touched nor in the way.
const profile = mkdtempSync(join(tmpdir(), 'kleos-dmg-'));
try {
  for (const [scale, name] of [
    [1, 'dmg-background.png'],
    [2, 'dmg-background@2x.png'],
  ]) {
    const out = join(buildDir, name);
    execFileSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        `--window-size=${width},${height}`,
        `--force-device-scale-factor=${scale}`,
        `--screenshot=${out}`,
        source,
      ],
      { stdio: 'ignore', timeout: 60_000 },
    );
    const size = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', out], { encoding: 'utf8' });
    const [w, h] = [/pixelWidth: (\d+)/, /pixelHeight: (\d+)/].map((re) => Number(re.exec(size)?.[1]));
    if (w !== width * scale || h !== height * scale) {
      throw new Error(`${name} is ${w} × ${h}, expected ${width * scale} × ${height * scale}`);
    }
    console.log(`${name}  ${w} × ${h}`);
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}
