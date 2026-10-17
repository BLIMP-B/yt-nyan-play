// A bounded HTTP origin with repeatable outages in the first part of a track.
export function createMediaNetworkFixture(ogg) {
  const pages = []; let offset = 0;
  while (offset < ogg.length) {
    if (ogg.toString('ascii', offset, offset + 4) !== 'OggS') throw new Error('Invalid Ogg fixture');
    const segments = ogg[offset + 26], header = 27 + segments;
    let size = header; for (let i = 0; i < segments; i++) size += ogg[offset + 27 + i];
    const granule = ogg.readBigInt64LE(offset + 6);
    pages.push({ at: granule > 0 ? Number(granule) / 48 : 0, bytes: ogg.subarray(offset, offset + size) }); offset += size;
  }
  const interruptions = [[3000, 3700], [6000, 7400], [9000, 11100]];
  return { interruptions, handle(request, response) {
    if (!request.url.startsWith('/network.ogg')) return false;
    response.writeHead(200, { 'Content-Type': 'audio/ogg', 'Cache-Control': 'no-store' });
    const began = performance.now(); let index = 0, timer;
    const sendAt = page => { const interval = interruptions.find(([from, to]) => page.at >= from && page.at < to); return interval ? interval[1] : page.at; };
    const pump = () => {
      while (index < pages.length && sendAt(pages[index]) <= performance.now() - began + 2) { if (!response.write(pages[index++].bytes)) { response.once('drain', pump); return; } }
      if (index === pages.length) response.end(); else timer = setTimeout(pump, Math.max(1, sendAt(pages[index]) - (performance.now() - began)));
    };
    response.once('close', () => clearTimeout(timer)); pump(); return true;
  } };
}

export function pcmContinuity(bytes) {
  const frames = [];
  for (let offset = 0; offset + 3840 <= bytes.length; offset += 3840) {
    let peak = 0; for (let i = offset; i < offset + 3840; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
    frames.push(peak > 50);
  }
  const first = frames.indexOf(true), last = frames.lastIndexOf(true);
  let run = 0, maximum = 0, gaps = 0;
  for (const audible of frames.slice(first, last + 1)) { if (audible) { if (run >= 5) gaps++; maximum = Math.max(maximum, run); run = 0; } else run++; }
  return { audibleFrames: frames.filter(Boolean).length, leadingMs: Math.max(0, first) * 20, longestInternalSilenceMs: maximum * 20, gapsOver100ms: gaps };
}
