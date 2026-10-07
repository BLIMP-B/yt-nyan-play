// Desktop requests have no Discord message from which to inherit a guild.
// Resolve only an unambiguous destination; never send to several guilds implicitly.
export function resolveDestination(payload, output, bindings, connections) {
  if (output === 'local') return { ...payload, guildId: String(payload.guildId || '') };
  const ready = connections.filter(c => c.status === 'ready').map(c => c.guildId);
  if (payload.master) {
    if (output === 'discord' && !ready.length) throw new Error('マスタ再生には、Discord接続から送信先のVCへ接続してください');
    return { ...payload, guildId: String(payload.guildId || '') };
  }
  let guildId = String(payload.guildId || '');
  if (!guildId) {
    if (ready.length === 1) guildId = ready[0];
    else if (!ready.length && bindings.length === 1) guildId = bindings[0].guildId;
  }
  if (output === 'discord' && !guildId) throw new Error('送信先サーバーを選択してください。複数のサーバーがある場合は自動選択しません');
  if (output === 'discord' && !bindings.some(b => b.guildId === guildId) && !ready.includes(guildId)) throw new Error('送信先サーバーの音声チャンネルを設定してください');
  return { ...payload, guildId };
}

// “Both” adds Discord only to an already participating Bot. Local playback is
// independent of voice permissions, empty channels and pending reconnections.
export function outputTargets(output, candidates, connections) {
  if (output === 'local') return [];
  const ids = [...new Set(candidates.filter(Boolean))];
  return output === 'both' ? ids.filter(id => connections.some(c => c.guildId === id && c.status === 'ready')) : ids;
}
export async function discordOutput(output, task, signal, log) {
  try { return await task(); }
  catch (error) {
    if (output !== 'both' || signal?.aborted) throw error;
    log('warn', `Discordへの出力を省略してPCで再生を続けます: ${error.message}`);
  }
}
