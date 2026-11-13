// 2026-11-03 (mick-agentic-browser): the jambonz client SDK imports React for its
// optional hooks (useJambonzClient/useCall). The console uses the plain client, so
// the bundle aliases 'react' to this stub; calling a hook throws a clear error.
const noReact = (name) => () => { throw new Error(`${name} needs React; the console uses createJambonzClient() directly`); };
export const useState = noReact('useState');
export const useEffect = noReact('useEffect');
export const useCallback = noReact('useCallback');
export const useRef = noReact('useRef');
export const useMemo = noReact('useMemo');
export default { useState, useEffect, useCallback, useRef, useMemo };
