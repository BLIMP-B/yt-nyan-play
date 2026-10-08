// Android's official `cmd notification get` uses NotificationRecord.dump(redact=false).
// Read only the primary notification; publicNotification is its lock-screen substitute.
export function parseAndroidNotification(dump) {
  if (typeof dump !== 'string' || Buffer.byteLength(dump) > 65536) return null;
  // Windows ADB returns CRLF. A trailing CR prevents per-line field matches
  // and makes the extras closing brace look like part of the last value.
  dump = dump.replace(/\r\n?/g, '\n');
  const flags = dump.match(/^\s*flags=(.*)$/m)?.[1] || '';
  if (/GROUP_SUMMARY|ONGOING_EVENT/.test(flags) || (Number(flags) & (0x200 | 0x2))) return null;
  const primary = dump.split(/^\s*notification=\s*$/m)[1]?.split(/^\s*publicNotification=\s*$/m)[0];
  if (!primary) return null;
  const start = /^([ \t]*)extras=\{\s*$/m.exec(primary);
  if (!start) return null;
  const lines = primary.slice(start.index + start[0].length).split('\n');
  const entries = new Map(); let key = '', value = '';
  const flush = () => { if (key) entries.set(key, value.trim()); };
  for (const line of lines) {
    if (line === start[1] + '}') { flush(); break; }
    const entry = /^(\s*)([\w.]+)=(.*)$/.exec(line);
    if (entry && entry[1].length === start[1].length + 4) { flush(); key = entry[2]; value = entry[3]; }
    else if (key) value += '\n' + line;
  }
  const string = name => {
    const raw = entries.get(name) || '';
    return /^(?:String|SpannableString|SpannableStringBuilder|SpannedString|CharSequence) \(([\s\S]*)\)$/.exec(raw)?.[1]?.trim() || '';
  };
  const title = string('android.title') || string('android.title.big');
  const body = string('android.bigText') || string('android.text') ||
    [...(entries.get('android.textLines') || '').matchAll(/^\s*\[\d+\] (.*)$/gm)].map(m => m[1]).join('。');
  if (!body && !title) return null;
  const text = [...[title, body].filter((v, i, all) => v && all.indexOf(v) === i).join('。')].slice(0, 2000).join('');
  return { title, body, text };
}

// These two settings can change while the VM runs. Hardware changes still require stopping it.
export function androidEnvironmentChanged(before, after) {
  const environment = ({ readNotifications, notificationOutput, ...rest }) => rest;
  return JSON.stringify(environment(before)) !== JSON.stringify(environment(after));
}
