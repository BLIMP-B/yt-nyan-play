import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSoundCloudShare } from '../apps/desktop/runtime/soundcloud.mjs';

const directory = resolve('dist/soundcloud-link-verification'); mkdirSync(directory, { recursive: true });
const urls = JSON.parse(process.env.NYAN_SOUNDCLOUD_LINKS || '["https://on.soundcloud.com/mnTxXSOAB7VR8gVSVm","https://on.soundcloud.com/mSGisM2jW5ftxL72bf","https://soundcloud.com/the80m/the-following"]');
// Public artifacts must not expose private-track secrets or signed queries.
const publicUrl = raw => {
  const url = new URL(raw); url.username = ''; url.password = ''; url.pathname = url.pathname.replace(/\/s-[^/]+/g, '/s-REDACTED');
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, 'REDACTED');
  url.hash = ''; return url.href;
};
const report = { platform: process.platform, version: JSON.parse(readFileSync('package.json')).version, method: 'GET with bounded official HTTP redirects', audioVerified: false, probes: [] };
for (const url of urls) {
  const probe = { source: publicUrl(url), requests: [] };
  try {
    const signal = AbortSignal.timeout(12000);
    const fetcher = async (target, options) => {
      const response = await fetch(target, options);
      const location = response.headers.get('location');
      probe.requests.push({ url: publicUrl(target), status: response.status, type: response.type, location: location ? publicUrl(new URL(location, target)) : null });
      return response;
    };
    const destination = await resolveSoundCloudShare(url, ['soundcloud.com'], fetcher, signal);
    probe.expanded = new URL(url).hostname === 'on.soundcloud.com' && new URL(destination).hostname !== 'on.soundcloud.com';
    probe.destination = publicUrl(destination);
    if (new URL(url).hostname !== 'on.soundcloud.com') {
      const response = await fetcher(url, { redirect: 'manual', signal }); await response.body?.cancel();
    }
  } catch (error) { probe.error = error.message; }
  report.probes.push(probe); console.log('SOUNDCLOUD_LINK', JSON.stringify(probe));
}
writeFileSync(resolve(directory, 'link-report.json'), JSON.stringify(report, null, 2));
