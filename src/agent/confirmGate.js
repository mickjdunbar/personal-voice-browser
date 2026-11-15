// 16 Nov 2026 (mick-agentic-browser): a two-step confirmation the MODEL cannot short-circuit.
// A `confirm: true` flag on the tool call is not enough — the fast lane passed it on the very first
// call ("Remove the DeepWiki MCP server" → confirm:true → gone) because the owner's request looked
// like consent to it. The gate is stateful instead: the first call for a target returns
// needs_confirmation and remembers {key, turn}; the SAME target is only allowed on a LATER owner
// turn (the question went out, the owner answered). A different target, or the same turn, asks again.
//
//   const g = confirmGate(state, 'remove_mcp_server:deepwiki', navigator.turns);
//   if (!g.ok) return { needs_confirmation: true, ... };
export function confirmGate(state, key, turn, { maxAgeMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  const p = state.pendingConfirm;
  if (p && p.key === key && turn > p.turn && now - p.at <= maxAgeMs) {
    state.pendingConfirm = null;
    return { ok: true };
  }
  state.pendingConfirm = { key, turn, at: now };
  return { ok: false, pending: state.pendingConfirm, reason: !p ? 'first ask' : p.key !== key ? 'different target' : turn <= p.turn ? 'same turn — the owner has not answered yet' : 'stale' };
}
