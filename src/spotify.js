// "Your Music": a crate built from a connected Spotify account.
//
// WHAT SPOTIFY IS AND IS NOT FOR HERE
//
// Spotify tells us *what you listen to* — top tracks over three windows and
// your liked songs — and nothing else. It cannot supply the audio: preview
// URLs were removed from the Web API for new apps in late 2024, and its
// streams are not something a static site can play anyway. So every song still
// has to be found in Apple's catalog, exactly like the built packs, and the
// personal pack that comes out the other end plays the same unsigned Apple
// previews as everything else. Spotify is consulted once, at import time.
//
// AUTH WITHOUT A BACKEND
//
// Authorization Code with PKCE runs entirely in the browser: no client secret
// exists, the code verifier lives in sessionStorage for the length of the
// redirect, and tokens are kept in localStorage under the earworm. prefix.
// Spotify requires redirect URIs to be https, or the loopback address for
// local work (http://127.0.0.1:5173/ — `localhost` is refused), so the dev
// server has to be opened at 127.0.0.1 for the round trip to work.
//
// THE MATCH IS THE COST
//
// Apple has no ISRC lookup (measured: /lookup?isrc= returns nothing), so the
// bridge from a Spotify track to an Apple one is /search, which is throttled
// to ~20 calls a minute per IP and answers a burst with 403s that last for
// minutes. The import therefore matches against the built packs first — free,
// no network, and it catches most of what a pop/rap/rock listener has — and
// only then searches Apple, one throttled call *per artist* rather than per
// song (an artistTerm search returns the artist's whole catalog), paced at
// GAP_MS, with a long back-off on 403. This is the single runtime path allowed
// to call /search, and it never runs during a round.

import { SPOTIFY_CLIENT_ID } from './config.js';
import { norm, coreTitle, artistMatches, searchSongs, RateLimited, JUNK } from './itunes.js';

const AUTH = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'user-top-read user-library-read';

const LS_TOKEN = 'earworm.spotify.token';
const SS_VERIFIER = 'earworm.spotify.verifier';
const SS_STATE = 'earworm.spotify.state';

/** Pause between Apple /search calls. 4s is 15/min, under the ~20/min ceiling. */
export const GAP_MS = 4000;
/** On a 403, wait this long before trying again. The penalty box is minutes. */
const COOLDOWN_MS = 60_000;
/** How many liked songs to pull, newest first. Top tracks come on top of this. */
const MAX_SAVED = 1000;
/** Calls fetchLibrary makes at most (3 top windows + saved pages), for progress. */
export const LIBRARY_STEPS = 3 + MAX_SAVED / 50;

/* --------------------------------------------------------------------- auth */

export const configured = () => Boolean(SPOTIFY_CLIENT_ID);

/** Where Spotify sends the browser back. Must be registered on the app verbatim. */
export function redirectUri() {
  // Always the site root, so there is exactly one URI to register per host
  // (a path like /index or a trailing-slash difference would not match).
  return location.origin + '/';
}

/** True when the page is on a host Spotify will refuse as a redirect target. */
export function redirectUnsupported() {
  return location.protocol === 'http:' && !/^127\.0\.0\.1(:\d+)?$/.test(location.host);
}

function randomString(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function challenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Leave the page for Spotify's consent screen. */
export async function connect() {
  if (!configured()) throw new Error('Spotify is not set up on this site yet.');
  if (redirectUnsupported()) {
    throw new Error(
      `Spotify refuses this address. Open the game at http://127.0.0.1:${location.port || 80}/ (not localhost) to connect.`
    );
  }
  const verifier = randomString(64);
  const state = randomString(16);
  sessionStorage.setItem(SS_VERIFIER, verifier);
  sessionStorage.setItem(SS_STATE, state);
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: await challenge(verifier),
    state,
  });
  location.assign(`${AUTH}?${params}`);
}

function readToken() {
  try {
    return JSON.parse(localStorage.getItem(LS_TOKEN));
  } catch {
    return null;
  }
}

function writeToken(t) {
  localStorage.setItem(
    LS_TOKEN,
    JSON.stringify({
      access: t.access_token,
      refresh: t.refresh_token || readToken()?.refresh || null,
      expires: Date.now() + (t.expires_in || 3600) * 1000,
    })
  );
}

export function connected() {
  return Boolean(readToken()?.refresh || readToken()?.access);
}

export function disconnect() {
  localStorage.removeItem(LS_TOKEN);
}

/**
 * If the URL carries Spotify's answer, exchange it for tokens. Returns true
 * when a code was handled (the caller should then clean the URL and start
 * the import), false when this is an ordinary page load. Throws on a failed
 * exchange or a state mismatch.
 */
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const err = q.get('error');
  if (!code && !err) return false;
  const state = sessionStorage.getItem(SS_STATE);
  const verifier = sessionStorage.getItem(SS_VERIFIER);
  sessionStorage.removeItem(SS_STATE);
  sessionStorage.removeItem(SS_VERIFIER);
  if (err) {
    throw new Error(
      err === 'access_denied'
        ? 'Spotify access was declined. Nothing was imported.'
        : `Spotify sign-in did not complete (${err}). Try again.`
    );
  }
  if (!state || q.get('state') !== state || !verifier) {
    throw new Error('The Spotify sign-in did not match this session. Try again.');
  }
  const body = await tokenRequest({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  writeToken(body);
  return true;
}

const NOT_APPROVED =
  "Spotify didn't allow this account. This app is limited to 5 approved people (and needs its owner's Premium to be active), so ask the owner to add your Spotify email. The rest of the game works without it.";

/** POST to Spotify's token endpoint and turn failures into plain sentences. */
async function tokenRequest(params) {
  let res;
  try {
    res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
  } catch {
    throw new Error("Couldn't reach Spotify. Check your connection and try again.");
  }
  if (res.ok) return res.json();
  const detail = await res.json().catch(() => ({}));
  if (res.status === 403) throw new Error(NOT_APPROVED);
  if (detail.error === 'invalid_grant') {
    throw new Error(
      params.grant_type === 'refresh_token'
        ? 'Spotify session expired. Connect again.'
        : 'That Spotify sign-in expired or was already used. Press Connect to try again.'
    );
  }
  if (detail.error === 'invalid_client') {
    throw new Error("Spotify doesn't recognise this site's client ID. The site owner needs to check src/config.js.");
  }
  throw new Error(`Spotify sign-in failed (${res.status}). Try again in a moment.`);
}

/** Mark the stored access token as spent so the next call refreshes it. */
function expireToken() {
  const t = readToken();
  if (t) localStorage.setItem(LS_TOKEN, JSON.stringify({ ...t, expires: 0 }));
}

async function accessToken() {
  const t = readToken();
  if (!t) throw new Error('Not connected to Spotify.');
  if (t.access && Date.now() < t.expires - 60_000) return t.access;
  if (!t.refresh) {
    disconnect();
    throw new Error('Spotify session expired. Connect again.');
  }
  try {
    writeToken(
      await tokenRequest({
        client_id: SPOTIFY_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: t.refresh,
      })
    );
  } catch (e) {
    // A refresh the server refuses can never succeed later: forget the dead
    // token so the card goes back to "Connect". A network blip keeps it.
    if (!/reach Spotify/.test(e.message)) disconnect();
    throw e;
  }
  return readToken().access;
}

async function api(path, { refreshed = false, tries = 0 } = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  });
  if (res.status === 429 && tries < 5) {
    const wait = Number(res.headers.get('Retry-After') || 2) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return api(path, { refreshed, tries: tries + 1 });
  }
  if (res.status === 401) {
    // Access tokens die early now and then. Refresh once, then give up.
    if (!refreshed) {
      expireToken();
      return api(path, { refreshed: true, tries });
    }
    disconnect();
    throw new Error('Spotify session expired. Connect again.');
  }
  if (res.status === 403) {
    // Development Mode only admits the accounts on the owner's allowlist.
    disconnect();
    throw new Error(NOT_APPROVED);
  }
  if (!res.ok) throw new Error(`Spotify had a problem (${res.status}). Try again in a moment.`);
  return res.json();
}

/* ------------------------------------------------------------------ library */

function fromSpotify(t, source) {
  return {
    sid: t.id,
    title: t.name,
    artist: t.artists?.[0]?.name || '',
    artists: (t.artists || []).map((a) => a.name),
    album: t.album?.name || '',
    year: (t.album?.release_date || '').slice(0, 4),
    popularity: t.popularity ?? 0,
    source,
  };
}

/**
 * Everything worth importing: top tracks over the short, medium and long
 * windows, then liked songs newest-first, deduped on Spotify id. Top tracks
 * come first so that if the artist-search cap bites, it bites the tail of the
 * liked list and not the songs you actually play.
 */
export async function fetchLibrary(onStatus = () => {}) {
  const byId = new Map();
  const out = [];
  // `rank` is the track's place in the list it came from (0 = first).
  const add = (items, source, rank) => {
    items.forEach((t, i) => {
      if (!t?.id) return;
      let row = byId.get(t.id);
      if (!row) {
        row = { ...fromSpotify(t, source), windows: 0, topPos: null, savedPos: null };
        byId.set(t.id, row);
        out.push(row);
      }
      if (source === 'top') {
        row.windows++;
        row.topPos = row.topPos === null ? i : Math.min(row.topPos, i);
      } else if (row.savedPos === null) {
        row.savedPos = rank + i;
      }
    });
  };
  for (const range of ['short_term', 'medium_term', 'long_term']) {
    onStatus(`Reading your top tracks (${range.replace('_term', '')})`);
    const data = await api(`/me/top/tracks?time_range=${range}&limit=50`);
    add(data.items || [], 'top', 0);
  }
  for (let offset = 0; offset < MAX_SAVED; offset += 50) {
    onStatus(`Reading your liked songs (${offset + 50})`);
    const data = await api(`/me/tracks?limit=50&offset=${offset}`);
    add((data.items || []).map((i) => i.track), 'saved', offset);
    if (!data.next) break;
  }
  // Spotify removed `popularity` for Development Mode apps (Feb 2026), which
  // is what the difficulty bands were cut from. Without it every track would
  // tie at 0 and the bands would just follow import order. So when the API
  // gives no popularity at all, rank by how well *you* know the song instead.
  const hasPopularity = out.some((t) => t.popularity > 0);
  for (const t of out) {
    t.derived = !hasPopularity;
    if (!hasPopularity) t.popularity = familiarity(t);
  }
  return out;
}

/**
 * 0..105: how familiar a song should be to this listener, from their own data.
 * Top tracks outrank liked songs; appearing in more of the three top windows
 * and sitting higher in them raises it; among liked songs, newer likes rank
 * higher. Only the order matters, since the bands are cut by rank.
 */
export function familiarity(t) {
  let score = 0;
  if (t.windows) score = 40 + t.windows * 12 + (1 - t.topPos / 50) * 24;
  if (t.savedPos !== null) {
    score = t.windows ? score + 5 : 5 + (1 - t.savedPos / MAX_SAVED) * 30;
  }
  return Math.round(score * 10) / 10;
}

/** A song that is easy in the built packs is likelier to be known, so it breaks ties up. */
const packBonus = (d) => (d === 1 ? 8 : d === 2 ? 4 : 0);

/* ------------------------------------------------------------------- match */

/** Key a title+lead-artist pair the way both catalogs can agree on. */
const key = (title, artist) => `${coreTitle(title)}|${norm(artist)}`;

/** Store row for a matched Apple result, in the packs' on-disk shape. */
function toRow(r) {
  return {
    i: r.trackId,
    t: r.trackName,
    a: r.artistName,
    b: r.collectionName || '',
    y: (r.releaseDate || '').slice(0, 4),
    p: r.previewUrl,
    w: (r.artworkUrl100 || '').replace('100x100bb', '400x400bb'),
  };
}

function usable(r) {
  if (!r.previewUrl || !r.trackName || !r.artistName) return false;
  if (JUNK.test(r.trackName) || JUNK.test(r.artistName)) return false;
  if (/\b(live|karaoke|instrumental|commentary)\b/i.test(r.trackName)) return false;
  return (r.trackTimeMillis || 0) >= 60_000;
}

/** Does this Apple result look like this Spotify track? */
function sameSong(want, r) {
  if (!artistMatches(want.artist, r.artistName)) return false;
  const a = coreTitle(want.title);
  const b = coreTitle(r.trackName);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

const leadOf = (a) => String(a).split(/\s*[,&]\s*|\s+(?:feat|ft|featuring|with|x)\.?\s+/i)[0];

/**
 * Turn Spotify tracks into stored-shape rows with Apple previews.
 *
 * `local` is the union of the built packs, already expanded, used as a free
 * first pass. `prior` is what an earlier import saved — its rows and the
 * artists it already searched — so a second run only does new work: the
 * import is meant to be spread over sittings, not finished in one. `onProgress`
 * reports as it goes; `onCheckpoint({rows, searched})` fires after every artist
 * so the caller can persist, which is what makes Stop and a closed tab cost
 * nothing; `signal` aborts between requests. Resolves with everything found so
 * far even when aborted, so a cancelled import still yields a playable crate.
 */
export async function matchToApple(
  wanted,
  local,
  { prior = null, onProgress = () => {}, onCheckpoint = () => {}, signal } = {}
) {
  const rows = new Map(); // apple trackId → row
  const done = new Set(); // spotify id
  // artist key → how many of their tracks were wanted when last searched. An
  // artist is searched again only if more of their songs have shown up since.
  const searched = { ...(prior?.searched || {}) };
  for (const r of prior?.rows || []) rows.set(String(r.i), r);
  const sleep = (ms) =>
    new Promise((resolve, reject) => {
      const id = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => (clearTimeout(id), reject(new DOMException('aborted', 'AbortError'))), {
        once: true,
      });
    });

  // 1. The built packs and the previous import. No network at all.
  const byKey = new Map();
  for (const t of local) {
    const k = key(t.title, leadOf(t.artist));
    if (!byKey.has(k)) byKey.set(k, { i: Number(t.id), t: t.title, a: t.artist, b: t.album, y: t.year, p: t.previewUrl, w: t.artwork, g: t.difficulty });
  }
  for (const r of rows.values()) {
    const k = key(r.t, leadOf(r.a));
    if (!byKey.has(k)) byKey.set(k, r);
  }
  for (const w of wanted) {
    const hit = byKey.get(key(w.title, w.artist));
    if (hit) {
      done.add(w.sid);
      const { g, ...row } = hit; // g: the built pack's own difficulty, never stored
      rows.set(String(hit.i), { ...row, pop: w.popularity + (w.derived ? packBonus(g) : 0) });
    }
  }
  onProgress({ phase: 'local', done: 0, total: 0, matched: rows.size });

  // 2. Apple, one throttled search per artist, most-wanted artists first.
  const byArtist = new Map();
  for (const w of wanted) {
    if (done.has(w.sid)) continue;
    const a = norm(w.artist);
    if (!byArtist.has(a)) byArtist.set(a, { key: a, name: w.artist, tracks: [] });
    byArtist.get(a).tracks.push(w);
  }
  const searchable = [...byArtist.values()]
    .filter((a) => !(a.key in searched) || a.tracks.length > searched[a.key])
    .sort((a, b) => b.tracks.length - a.tracks.length);
  let n = 0;
  const report = (note) =>
    onProgress({ phase: 'apple', done: n, total: searchable.length, matched: rows.size, note });

  try {
    for (const artist of searchable) {
      if (signal?.aborted) break;
      report(`Searching Apple for ${artist.name}`);
      let results = null;
      for (let attempt = 0; results === null && attempt < 3; attempt++) {
        try {
          results = await searchSongs(artist.name, { attribute: 'artistTerm' });
        } catch (e) {
          if (!(e instanceof RateLimited)) {
            results = [];
            break;
          }
          const wait = COOLDOWN_MS * (attempt + 1);
          report(`Apple is rate-limiting — waiting ${wait / 1000}s`);
          await sleep(wait);
        }
      }
      // A rate-limited artist that never answered stays unsearched, so the
      // next run tries again. A real (empty) answer is remembered.
      if (results !== null) {
        for (const w of artist.tracks) {
          const hit = results.filter(usable).find((r) => sameSong(w, r));
          if (hit) {
            done.add(w.sid);
            rows.set(String(hit.trackId), { ...toRow(hit), pop: w.popularity });
          }
        }
        searched[artist.key] = artist.tracks.length;
      }
      n++;
      report();
      onCheckpoint({ rows: band([...rows.values()]), searched, artistsLeft: searchable.length - n });
      if (n < searchable.length) await sleep(GAP_MS);
    }
  } catch (e) {
    // A cancelled import keeps what it found. Anything else is a real error.
    if (e.name !== 'AbortError') throw e;
  }

  return {
    rows: band([...rows.values()]),
    searched,
    unmatched: wanted.length - done.size,
    artistsLeft: searchable.length - n,
    aborted: Boolean(signal?.aborted),
  };
}

/**
 * Difficulty inside your own crate is Spotify's popularity, cut the same way
 * as the built packs (15% / 30% / rest). It hardly matters — you know your own
 * music — but the picker and the daily need a band on every track. `pop` is
 * kept on the row so a later, larger import can re-cut without asking Spotify.
 */
function band(rows) {
  rows.sort((a, b) => (b.pop ?? 0) - (a.pop ?? 0));
  const easyEnd = Math.ceil(rows.length * 0.15);
  const mediumEnd = Math.ceil(rows.length * 0.45);
  return rows.map((r, i) => ({ ...r, d: i < easyEnd ? 1 : i < mediumEnd ? 2 : 3 }));
}
