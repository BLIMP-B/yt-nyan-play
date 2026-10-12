// Run after command/tag interpretation: only the delimiters are silent.
// Never remove their contents, including nested or unmatched brackets.
export function spokenText(text) {
  return String(text).replace(/[\p{Ps}\p{Pe}\p{Pi}\p{Pf}"]/gu, '');
}
