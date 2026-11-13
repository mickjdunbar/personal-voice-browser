// 2026-11-06 (mick-agentic-browser): PROVIDER PRESETS for the external-chatbot bridge.
// A configured bot names a PROVIDER, which tells the ask_chatbot bridge how to shape the
// request for that kind of endpoint — the method, the auth header, the JSON body, and how
// to read the reply back out. The provider list is grounded in the agent endpoint kinds we
// run through Huey/jambonz (ElevenLabs, Vertex Agent, CX Agent Studio) plus the common
// REST chatbot platforms (Cognigy, Dialogflow CX, OpenAI, Rasa). "custom" is the fully
// manual escape hatch for anything else.
//
// Each bot supplies: { name, provider, url, apiKey?, model?, headers?, bodyTemplate?,
//   replyPath?, dropPattern? }. The preset turns those into an actual HTTP request; the per
// -bot headers/bodyTemplate/replyPath always OVERRIDE the preset, so an odd endpoint can be
// made to work without a code change. `vars` = { message, session, user }.

// Pull reply text out of common object shapes, in order. Shared with the generic extractor.
export function genericParts(data) {
  if (typeof data === 'string') return data.trim() ? [data.trim()] : [];
  if (data && typeof data === 'object') {
    const arr = data.outputStack || data.outputs || data.messages || data.results;
    if (Array.isArray(arr)) {
      const parts = arr.map((o) => (typeof o === 'string' ? o : (o && (o.text || o.message || o.reply || o.answer)))).filter((t) => typeof t === 'string' && t.trim());
      if (parts.length) return parts;
    }
    for (const k of ['text', 'reply', 'response', 'answer', 'message', 'output', 'output_text', 'speech']) {
      const v = data[k];
      if (typeof v === 'string' && v.trim()) return [v.trim()];
      if (Array.isArray(v)) { const t = v.filter((x) => typeof x === 'string' && x.trim()); if (t.length) return t; }
    }
    if (data.data) return genericParts(data.data);
  }
  return [];
}

export const PROVIDERS = {
  cognigy: {
    label: 'Cognigy (REST endpoint)',
    auth: 'key', authHeader: 'X-API-Key',
    keyLabel: 'API key', keyHint: 'optional — Cognigy REST endpoints carry the token in the URL, so usually blank',
    urlLabel: 'Endpoint URL', urlHint: 'https://endpoint-au-02.cognigy.ai/<rest-endpoint-token>',
    note: 'The webchat/REST endpoint of your Cognigy agent (Deploy → Endpoints → REST).',
    method: 'POST',
    body: (b, v) => ({ userId: v.user, sessionId: v.session, text: v.message }),
    // Cognigy returns { text } or a multi-output { outputStack:[{text}] } — genericParts handles both.
    extract: (data) => genericParts(data)
  },
  dialogflow_cx: {
    label: 'Google Dialogflow CX',
    auth: 'bearer',
    keyLabel: 'Access token (Bearer)', keyHint: 'a Google OAuth access token (gcloud auth print-access-token) or a proxy that injects one',
    urlLabel: 'Session URL', urlHint: 'https://REGION-dialogflow.googleapis.com/v3/projects/P/locations/L/agents/A/sessions/{{session}}:detectIntent',
    note: 'Use {{session}} in the URL where the session id goes. Needs a valid Google bearer token.',
    method: 'POST',
    body: (b, v) => ({ queryInput: { text: { text: v.message }, languageCode: b.languageCode || 'en' } }),
    extract: (data) => {
      const msgs = data?.queryResult?.responseMessages || [];
      const parts = [];
      for (const m of msgs) if (m?.text?.text) parts.push(...m.text.text);
      return parts.length ? parts.filter((s) => s && s.trim()) : genericParts(data);
    }
  },
  vertex_agent: {
    label: 'Google Vertex AI Agent (Agent Engine)',
    auth: 'bearer',
    keyLabel: 'Access token (Bearer)', keyHint: 'a Google OAuth access token or a proxy that injects one',
    urlLabel: 'Query URL', urlHint: 'https://REGION-aiplatform.googleapis.com/v1/projects/P/locations/L/reasoningEngines/E:query',
    note: 'Best-effort shape; use Advanced overrides if your engine expects a different input/output.',
    method: 'POST',
    body: (b, v) => ({ input: { input: v.message }, class_method: b.classMethod || 'query' }),
    extract: (data) => {
      const out = data?.output;
      if (typeof out === 'string' && out.trim()) return [out.trim()];
      return genericParts(data);
    }
  },
  cx_agent_studio: {
    label: 'Google CX Agent Studio (CES runSession)',
    auth: 'bearer',
    keyLabel: 'Access token (Bearer)', keyHint: 'a Google OAuth access token or a proxy that injects one',
    urlLabel: 'runSession URL', urlHint: 'https://ces.googleapis.com/v1alpha/projects/P/locations/L/agents/A:runSession',
    note: 'Best-effort shape (same family as our jambonz CES app); use Advanced overrides if needed.',
    method: 'POST',
    body: (b, v) => ({ session: v.session, queryInput: { text: { text: v.message }, languageCode: b.languageCode || 'en' } }),
    extract: (data) => genericParts(data)
  },
  elevenlabs: {
    label: 'ElevenLabs (Conversational AI)',
    auth: 'key', authHeader: 'xi-api-key',
    keyLabel: 'API key (xi-api-key)', keyHint: 'your ElevenLabs API key',
    urlLabel: 'Endpoint URL', urlHint: 'https://api.elevenlabs.io/v1/convai/agents/<agent_id>/simulate-conversation',
    note: 'ElevenLabs ConvAI is primarily WebSocket; this targets a text/simulate endpoint. Use Advanced overrides if your endpoint differs.',
    method: 'POST',
    body: (b, v) => ({ text: v.message }),
    extract: (data) => genericParts(data)
  },
  openai: {
    label: 'OpenAI (Responses API)',
    auth: 'bearer',
    keyLabel: 'API key (Bearer)', keyHint: 'your OpenAI API key (sk-…)',
    urlLabel: 'Endpoint URL', urlHint: 'https://api.openai.com/v1/responses',
    note: 'Single-turn via the Responses API. Set a model below.',
    model: true,
    method: 'POST',
    body: (b, v) => ({ model: b.model || 'gpt-5.4-mini', input: v.message }),
    extract: (data) => {
      if (typeof data?.output_text === 'string' && data.output_text.trim()) return [data.output_text.trim()];
      const out = data?.output;
      if (Array.isArray(out)) {
        const parts = [];
        for (const o of out) for (const c of (o?.content || [])) if (typeof c?.text === 'string' && c.text.trim()) parts.push(c.text.trim());
        if (parts.length) return parts;
      }
      return genericParts(data);
    }
  },
  rasa: {
    label: 'Rasa (REST webhook)',
    auth: 'none',
    keyLabel: '', keyHint: '',
    urlLabel: 'Webhook URL', urlHint: 'https://your-rasa-host/webhooks/rest/webhook',
    note: 'Rasa Open Source REST channel. Usually no auth.',
    method: 'POST',
    body: (b, v) => ({ sender: v.session, message: v.message }),
    extract: (data) => (Array.isArray(data) ? data.map((x) => x && (x.text || x.message)).filter((t) => typeof t === 'string' && t.trim()) : genericParts(data))
  },
  custom: {
    label: 'Custom HTTP (advanced)',
    auth: 'key', authHeader: 'Authorization',
    keyLabel: 'Auth header value', keyHint: 'optional — sent as the Authorization header; or set your own headers in Advanced',
    urlLabel: 'Endpoint URL', urlHint: 'https://…',
    note: 'Fully manual. Set the body with Advanced overrides (textKey/sessionKey/userKey or a bodyTemplate) and a replyPath.',
    method: 'POST',
    body: (b, v) => { const o = {}; o[b.textKey || 'text'] = v.message; o[b.sessionKey || 'sessionId'] = v.session; o[b.userKey || 'userId'] = v.user; return o; },
    extract: (data, b) => genericParts(data)
  }
};

export const DEFAULT_PROVIDER = 'cognigy';

export function getProvider(id) { return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER]; }

/** Metadata the console needs to render the Add-a-chatbot form (no secrets, no functions). */
export function providerMeta() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, label: p.label, auth: p.auth, keyLabel: p.keyLabel, keyHint: p.keyHint,
    urlLabel: p.urlLabel, urlHint: p.urlHint, note: p.note, model: !!p.model
  }));
}
