// GuildVoiceStates is authoritative; channel.members is a fallback for cached
// channels. An event overlay also handles a departed member lingering in a cache.
export function hasHumanListeners(guild, channelId, transition) {
  const states = guild?.voiceStates?.cache, members = guild?.channels?.cache?.get(channelId)?.members;
  if (!states && !members && !transition) return null;
  const humans = new Set();
  if (states) for (const state of states.values()) {
    if (state.channelId === channelId && state.member?.user.bot === false) humans.add(state.id);
  }
  else if (members) for (const member of members.values()) if (member.user?.bot === false) humans.add(member.id);
  if (transition) {
    const { previous, next } = transition, member = next.member || previous.member;
    humans.delete(next.id);
    if (next.channelId === channelId && member?.user.bot === false) humans.add(next.id);
  }
  return humans.size > 0;
}
