// Renders the app icon from apps/desktop/build/icon.svg into icon.png (1024 × 1024, transparent
// corners) beside it, with headless Chrome. electron-builder makes the .icns from icon.png, and
// the README shows it. Usage: node scripts/icon.mjs  (set CHROME=<path> for another Chrome)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const buildDir = fileURLToPath(new URL('../apps/desktop/build/', import.meta.url));
const source = pathToFileURL(join(buildDir, 'icon.svg')).href;
const out = join(buildDir, 'icon.png');
const size = 1024;

// A throwaway profile, so an open Chrome is neither touched nor in the way.
const profile = mkdtempSync(join(tmpdir(), 'kleos-icon-'));
try {
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--window-size=${size},${size}`,
      '--force-device-scale-factor=1',
      // Transparent page: the corners outside the squircle stay see-through, as macOS expects.
      '--default-background-color=00000000',
      `--screenshot=${out}`,
      source,
    ],
    { stdio: 'ignore', timeout: 60_000 },
  );
  const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', out], {
    encoding: 'utf8',
  });
  const [w, h] = [/pixelWidth: (\d+)/, /pixelHeight: (\d+)/].map((re) => Number(re.exec(info)?.[1]));
  if (w !== size || h !== size) throw new Error(`icon.png is ${w} × ${h}, expected ${size} × ${size}`);
  if (!/hasAlpha: yes/.test(info)) throw new Error('icon.png has no alpha channel: its corners would be opaque');
  console.log(`icon.png  ${w} × ${h}, transparent corners`);
} finally {
  rmSync(profile, { recursive: true, force: true });
}
