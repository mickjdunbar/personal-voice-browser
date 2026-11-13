// 2026-11-03 (mick-agentic-browser): tiny leveled console logger (no deps).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const level = () => LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;
const stamp = () => new Date().toISOString().slice(11, 23);

export function createLogger(label) {
  const out = (lvl, fn) => (msg, extra) => {
    if (LEVELS[lvl] < level()) return;
    const tail = extra !== undefined ? ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : '';
    fn(`${stamp()} [${label}] ${lvl}: ${msg}${tail}`);
  };
  return {
    debug: out('debug', console.debug),
    info: out('info', console.log),
    warn: out('warn', console.warn),
    error: out('error', console.error),
    child: (sub) => createLogger(`${label}:${sub}`)
  };
}

export const appLogger = createLogger('MAB');
