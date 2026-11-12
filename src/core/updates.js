'use strict';
/**
 * "Is there a newer Tokkie?" — the one place Tokkie goes online, and only when you switch it on (Settings → About).
 * Once a day it asks GitHub for the latest release of Tokkie's own repository. The request carries nothing about you:
 * no usage, no prompts, no ids — just a plain GET with a generic User-Agent. Downloading stays in your browser.
 */
const REPO = 'cmykRgb38/tokkie';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

/** 1.0.44 vs 1.0.45 → -1, equal → 0. Ignores a leading "v" and anything after a dash. */
function compareVersions(a, b) {
  const p = (v) => String(v || '').replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

/** Only ever open a page on Tokkie's own GitHub releases. */
function safeReleaseUrl(u) {
  return typeof u === 'string' && u.startsWith(RELEASES_PAGE + '/') && !/[\s"'<>]/.test(u) ? u : RELEASES_PAGE;
}

/**
 * @param {{current:string, fetchImpl?:Function, now?:number}} o
 * @returns {Promise<{ok:true, latest:string, newer:boolean, url:string, at:number} | {ok:false, error:string, at:number}>}
 */
async function checkForUpdate({ current, fetchImpl, now = Date.now() }) {
  const get = fetchImpl || require('electron').net.fetch;
  try {
    const res = await get(LATEST_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Tokkie-update-check' } });
    if (!res.ok) return { ok: false, error: res.status === 404 ? 'no releases yet' : `GitHub said ${res.status}`, at: now };
    const j = await res.json();
    const latest = String(j.tag_name || '').replace(/^v/i, '');
    if (!/^\d+(\.\d+){1,3}$/.test(latest)) return { ok: false, error: 'unexpected answer', at: now };
    return { ok: true, latest, newer: compareVersions(current, latest) < 0, url: safeReleaseUrl(j.html_url), at: now };
  } catch {
    return { ok: false, error: 'offline or GitHub unreachable', at: now };
  }
}

module.exports = { checkForUpdate, compareVersions, safeReleaseUrl, LATEST_URL, RELEASES_PAGE };
