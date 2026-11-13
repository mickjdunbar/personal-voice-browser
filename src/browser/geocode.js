// 13 Nov 2026 (mick-agentic-browser): GEOCODING for drop_pin — turn a place name / address into a
// lat/lon plus a clean one-line address, so a pin can be put on the caller's Personal Voice
// Browser screen (OpenStreetMap marker URL) and the spot shared by text as a Google Maps link.
//
// Photon (komoot, OSM data, no key) is the primary — Nominatim resets connections from some
// networks (seen 13 Nov from this box) so it is only the fallback. Both are free services with
// a fair-use policy: one lookup per pin, never in a loop.
import { createLogger } from '../logger.js';

const logger = createLogger('Geocode');
const UA = 'PersonalVoiceBrowser/1.0 (personal assistant; one lookup per pin)';

function photonAddress(p = {}) {
  const line1 = [p.housenumber, p.street].filter(Boolean).join(' ');
  const parts = [p.name && p.name !== line1 ? p.name : '', line1, p.district && p.district !== p.city ? p.district : '', p.city, p.state, p.postcode];
  return parts.filter(Boolean).join(', ');
}

async function viaPhoton(q, { lang = 'en' } = {}) {
  const url = `https://photon.komoot.io/api/?limit=1&lang=${lang}&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`photon HTTP ${r.status}`);
  const f = (await r.json())?.features?.[0];
  if (!f?.geometry?.coordinates) return null;
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties || {};
  return { lat: Number(lat), lon: Number(lon), name: p.name || q, address: photonAddress(p), kind: p.osm_value || p.type || '', source: 'photon' };
}

async function viaNominatim(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`nominatim HTTP ${r.status}`);
  const h = (await r.json())?.[0];
  if (!h) return null;
  const a = h.address || {};
  const line1 = [a.house_number, a.road].filter(Boolean).join(' ');
  const address = [h.name && h.name !== line1 ? h.name : '', line1, a.suburb || a.neighbourhood || '', a.city || a.town || a.village || '', a.state, a.postcode].filter(Boolean).join(', ');
  return { lat: Number(h.lat), lon: Number(h.lon), name: h.name || q, address: address || h.display_name, kind: h.type || '', source: 'nominatim' };
}

/**
 * Geocode a free-text place. Returns null when nothing matched (never throws for a miss).
 * @param {string} place e.g. "Rogue Bistro Newstead" or "14 Austin St, Newstead QLD"
 * @param {string} [near] extra context appended when the place alone is ambiguous ("Brisbane")
 */
export async function geocode(place, near = '') {
  const q = [place, near].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  if (!q) return null;
  const attempts = [() => viaPhoton(q), () => viaNominatim(q)];
  if (near) attempts.push(() => viaPhoton(String(place).trim())); // the context may have confused it
  let lastErr = null;
  for (const run of attempts) {
    try { const hit = await run(); if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lon)) return hit; }
    catch (err) { lastErr = err; logger.debug(`geocode attempt failed: ${err.message}`); }
  }
  if (lastErr) logger.warn(`geocode "${q}" failed: ${lastErr.message}`);
  return null;
}

/** URLs for a pinned spot: the OpenStreetMap page with a marker (what the screen shows) and a
 *  Google Maps link (what gets texted — opens in any phone's maps app). */
export function pinUrls(lat, lon, zoom = 17) {
  const la = Number(lat).toFixed(6), lo = Number(lon).toFixed(6);
  return {
    osm: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=${zoom}/${la}/${lo}`,
    maps: `https://maps.google.com/?q=${la},${lo}`
  };
}
