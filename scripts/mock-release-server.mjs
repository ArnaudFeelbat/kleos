// A stand-in for GitHub's "latest release" API, for scripted tours of the update notice.
// Start it, then launch Kleos with KLEOS_UPDATE_URL=http://127.0.0.1:<port>/latest.
//
//   node scripts/mock-release-server.mjs [version] [port]
//
// It answers every GET with one published release of that version (default 9.9.9).
import { createServer } from 'node:http';

const version = process.argv[2] ?? '9.9.9';
const port = Number(process.argv[3] ?? 0);
const repo = 'https://github.com/ArnaudFeelbat/kleos';

const release = {
  tag_name: `v${version}`,
  name: `Kleos ${version}`,
  draft: false,
  prerelease: false,
  html_url: `${repo}/releases/tag/v${version}`,
  published_at: new Date().toISOString(),
  body: [
    '### Plus rapide',
    '',
    '- **Données** : les grandes tables s’ouvrent plus vite.',
    '- Le délai d’attente des requêtes (`statement_timeout`) est réglable.',
    '',
    '### Corrigé',
    '',
    '- Un tunnel SSH coupé est signalé comme tel.',
  ].join('\n'),
  assets: [
    {
      name: `Kleos-${version}-arm64.dmg`,
      browser_download_url: `${repo}/releases/download/v${version}/Kleos-${version}-arm64.dmg`,
    },
  ],
};

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(release));
});
server.listen(port, '127.0.0.1', () => {
  console.log(`mock release ${version} on http://127.0.0.1:${server.address().port}/latest`);
});
