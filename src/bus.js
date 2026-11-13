// 2026-11-03 (mick-agentic-browser): in-process bus between the harness side
// of a call and the conductor side of the SAME call (keyed by call_sid). The
// harness protocol has no channel back to the jambonz application, so when
// both run in this process the harness announces "hand the caller back to
// speech-to-speech" here and the conductor listens.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(500);
export const topic = (callSid, name) => `${name}:${callSid}`;
