// 2026-11-03 (mick-agentic-browser): role selection. One role today —
// navigator (standalone or specialist). ?role= and metadata.role are honoured
// so more roles can be added without touching the server.
import * as navigator from './navigator.js';

export const ROLES = { navigator };

export function pickRole(start, roleHint = '') {
  const md = start.metadata || {};
  const hinted = String(roleHint || md.role || md.env_vars?.role || '').toLowerCase();
  return ROLES[hinted] || navigator;
}
