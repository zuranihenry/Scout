import type {
  Album,
  Settings,
  DiscogsReleaseDetail,
  DiscogsFormat,
  TrackerStatus,
  TrackerRequest,
  GazelleArtistTorrentGroup,
  GazelleArtistRequest,
  GazelleGroupDetail,
  GazelleGroupTorrent,
  TrackerMatchResult,
} from '../types';
import { parseDuration, filterAudioTracks, stripDiscogsDisambiguator } from './discogs';

// -- Trackers -------------------------------------------------------

export type TrackerId = 'red' | 'ops';

interface Tracker {
  id: TrackerId;
  name: string;
  siteUrl: string;
  rateLimit: number;
  rateWindow: number;
  rateLimitPause: number;  // How long to stop after the tracker says we're rate limited
  // The server's own window: one counter for all actions, whose length and limit
  // come from the action that opens it, as [requests, seconds]
  actionLimits?: Record<string, [number, number]>;
  authorization: (apiKey: string) => string;
  // Failed logins come back as HTTP 200 with an error message
  jsonAuthErrors: boolean;
  forbiddenMessage: string;
  media: Record<string, string>;               // Discogs format name to media
  releaseTypes: Record<string, number>;        // Discogs format description to release type
  browseReleaseTypes: Record<string, number>;  // Browse release type name to release type
  browseTitleParam: string;
  // The artist response lists the artist's open requests, which saves a requests search
  artistRequests: boolean;
  // An edition without a year is the original release, rather than an unknown one
  editionYearFallback: boolean;
  // trumpable only says the torrent is reported or missing lineage
  trumpableMeansReported: boolean;
}

export const TRACKERS: Record<TrackerId, Tracker> = {
  red: {
    id: 'red',
    name: 'RED',
    siteUrl: 'https://redacted.sh',
    rateLimit: 10,
    rateWindow: 10_000,
    rateLimitPause: 10_000,
    authorization: (apiKey) => apiKey,
    jsonAuthErrors: false,
    forbiddenMessage: 'The RED API key is not authorised for this action. Please make sure it is enabled for Torrents and Requests.',
    media: {
      'CD': 'CD', 'CDr': 'CD',
      'Vinyl': 'Vinyl',
      'Cassette': 'Cassette',
      'Blu-ray': 'Blu-Ray',
      'DVD': 'DVD',
      'SACD': 'SACD',
    },
    releaseTypes: {
      'Album': 1, 'Soundtrack': 3, 'EP': 5, 'Anthology': 6,
      'Compilation': 7, 'Single': 9, 'Live': 11, 'Remix': 13,
      'Mixtape': 16, 'Demo': 17, 'DJ Mix': 19,
    },
    browseReleaseTypes: {
      'Album': 1, 'Soundtrack': 3, 'EP': 5, 'Anthology': 6,
      'Compilation': 7, 'Single': 9, 'Live album': 11, 'Remix': 13,
      'Bootleg': 14, 'Interview': 15, 'Mixtape': 16, 'Demo': 17,
      'Concert Recording': 18, 'DJ Mix': 19, 'Unknown': 21,
    },
    browseTitleParam: 'groupname',
    artistRequests: false,
    editionYearFallback: true,
    trumpableMeansReported: false,
  },
  ops: {
    id: 'ops',
    name: 'OPS',
    siteUrl: 'https://orpheus.network',
    rateLimit: 5,
    rateWindow: 10_000,
    rateLimitPause: 60_000,
    actionLimits: { artist: [15, 30], browse: [5, 10], requests: [5, 60], torrentgroup: [15, 60] },
    authorization: (apiKey) => `token ${apiKey}`,
    jsonAuthErrors: true,
    forbiddenMessage: 'OPS refused the request. Log in to OPS in a browser to check your account.',
    media: {
      'CD': 'CD', 'CDr': 'CD',
      'Vinyl': 'Vinyl',
      'Cassette': 'Cassette',
      'Blu-ray': 'BD',
      'DVD': 'DVD',
      'SACD': 'SACD',
    },
    releaseTypes: {
      'Album': 1, 'Soundtrack': 3, 'EP': 5, 'Anthology': 6,
      'Compilation': 7, 'Single': 9, 'Live': 11, 'Remix': 13,
      'Mixtape': 16, 'Demo': 10, 'DJ Mix': 17,
    },
    browseReleaseTypes: {
      'Album': 1, 'Soundtrack': 3, 'EP': 5, 'Anthology': 6,
      'Compilation': 7, 'Sampler': 8, 'Single': 9, 'Demo': 10,
      'Live album': 11, 'Split': 12, 'Remix': 13, 'Bootleg': 14,
      'Interview': 15, 'Mixtape': 16, 'DJ Mix': 17, 'Concert recording': 18,
      'Unknown': 21,
    },
    browseTitleParam: 'searchstr',
    artistRequests: true,
    editionYearFallback: false,
    trumpableMeansReported: true,
  },
};

export const TRACKER_IDS: TrackerId[] = ['red', 'ops'];

export const STATUS_FIELD: Record<TrackerId, 'redStatus' | 'opsStatus'> = {
  red: 'redStatus',
  ops: 'opsStatus',
};

export function apiKeyFor(settings: Settings, tracker: TrackerId): string {
  return tracker === 'red' ? settings.redApiKey : settings.opsApiKey;
}

/** The trackers that have an API key, in display order. */
export function configuredTrackers(settings: Settings): TrackerId[] {
  return TRACKER_IDS.filter((tracker) => apiKeyFor(settings, tracker));
}

/** "RED", "OPS" or "RED & OPS", for labels. */
export function trackerNames(trackers: TrackerId[]): string {
  return trackers.map((tracker) => TRACKERS[tracker].name).join(' & ');
}

export function trackerStatus(album: Album, tracker: TrackerId): TrackerStatus | undefined {
  return album[STATUS_FIELD[tracker]];
}

// Most torrent groups fetched per lookup, so a common title can't use up the rate limit
const MAX_GROUP_FETCHES = 5;

// -- Errors ---------------------------------------------------------

// After a 401, block all requests to that tracker until the API key changes.
// A 403 is surfaced as a warning but does not block future requests.
export class TrackerAuthError extends Error {
  constructor(
    tracker: TrackerId,
    message = `The ${TRACKERS[tracker].name} API key is invalid. Requests are paused to prevent an IP ban. Change your API key in Settings.`,
  ) {
    super(message);
    this.name = 'TrackerAuthError';
    this.title = 'Careful now...';
    this.tracker = tracker;
  }
  title: string;
  tracker: TrackerId;
}

export class TrackerForbiddenError extends Error {
  constructor(tracker: TrackerId) {
    super(TRACKERS[tracker].forbiddenMessage);
    this.name = 'TrackerForbiddenError';
    this.title = 'Ei perkele!';
    this.tracker = tracker;
  }
  title: string;
  tracker: TrackerId;
}

// The tracker couldn't answer (rate limit, server error, network or an error page),
// so the release's status is unknown rather than not uploaded.
export class TrackerUnavailableError extends Error {
  constructor(tracker: TrackerId) {
    super(`${TRACKERS[tracker].name} is busy or unreachable right now. Try again later.`);
    this.name = 'TrackerUnavailableError';
    this.title = `${TRACKERS[tracker].name} unavailable`;
    this.tracker = tracker;
  }
  title: string;
  tracker: TrackerId;
}

/** Errors that end a lookup instead of counting as "not found". */
function isTrackerError(err: unknown): boolean {
  return err instanceof TrackerAuthError || err instanceof TrackerForbiddenError || err instanceof TrackerUnavailableError;
}

// -- Rate limiter (sliding window) ----------------------------------

interface LimiterState {
  requestTimestamps: number[];
  // Set when the tracker rate limits us, holding every request until its window has passed
  pausedUntil: number;
  blockedApiKey: string | null;
  actionWindow: { end: number; count: number };
}

const limiters: Record<TrackerId, LimiterState> = {
  red: { requestTimestamps: [], pausedUntil: 0, blockedApiKey: null, actionWindow: { end: 0, count: 0 } },
  ops: { requestTimestamps: [], pausedUntil: 0, blockedApiKey: null, actionWindow: { end: 0, count: 0 } },
};

/** Retry-After is in whole seconds, so wait one more to cover the rounding. */
function retryAfterMs(t: Tracker, res: Response): number {
  const seconds = parseInt(res.headers.get('Retry-After') ?? '', 10);
  return seconds >= 0 ? (seconds + 1) * 1000 : t.rateWindow;
}

async function rateLimitedFetch(
  t: Tracker,
  params: Record<string, string>,
  apiKey: string,
): Promise<Response> {
  const state = limiters[t.id];
  const actionLimit = t.actionLimits?.[params.action!];
  let opensWindow = false;
  // Check again after every wait, since other callers may have taken the free slot
  while (true) {
    if (state.blockedApiKey !== null && state.blockedApiKey === apiKey) {
      throw new TrackerAuthError(t.id);
    }
    const now = Date.now();
    while (state.requestTimestamps.length > 0 && state.requestTimestamps[0]! <= now - t.rateWindow) {
      state.requestTimestamps.shift();
    }
    const window = state.actionWindow;
    const windowOpen = now < window.end;
    const windowFull = !!actionLimit && windowOpen && window.count >= actionLimit[0];
    if (now >= state.pausedUntil && state.requestTimestamps.length < t.rateLimit && !windowFull) {
      state.requestTimestamps.push(now);
      if (actionLimit) {
        opensWindow = !windowOpen;
        // A second of margin, since the server starts its window when the request arrives
        state.actionWindow = opensWindow
          ? { end: now + actionLimit[1] * 1000 + 1000, count: 1 }
          : { end: window.end, count: window.count + 1 };
      }
      break;
    }
    let waitUntil = now < state.pausedUntil ? state.pausedUntil : now;
    if (state.requestTimestamps.length >= t.rateLimit) {
      waitUntil = Math.max(waitUntil, state.requestTimestamps[0]! + t.rateWindow);
    }
    if (windowFull) waitUntil = Math.max(waitUntil, window.end);
    await new Promise((resolve) => setTimeout(resolve, waitUntil - now));
  }
  const url = `${t.siteUrl}/ajax.php?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: t.authorization(apiKey) } }).catch(() => {
    throw new TrackerUnavailableError(t.id);
  });
  if (opensWindow && actionLimit) {
    state.actionWindow.end = Math.max(state.actionWindow.end, Date.now() + actionLimit[1] * 1000 + 1000);
  }
  if (res.status === 401) {
    state.blockedApiKey = apiKey;
    throw new TrackerAuthError(t.id);
  }
  if (res.status === 403) {
    throw new TrackerForbiddenError(t.id);
  }
  if (res.status === 429) {
    state.pausedUntil = Math.max(state.pausedUntil, Date.now() + retryAfterMs(t, res));
  }
  if (res.status === 429 || res.status >= 500) {
    throw new TrackerUnavailableError(t.id);
  }
  return res;
}

/** Parse a tracker response. An error page or a rate limit failure means the tracker couldn't answer. */
async function readJson<T extends { status: string; error?: string }>(t: Tracker, res: Response, apiKey: string): Promise<T> {
  const data: T = await res.json().catch(() => {
    throw new TrackerUnavailableError(t.id);
  });
  if (data.status === 'success') return data;
  const error = data.error ?? '';
  const state = limiters[t.id];
  if (t.jsonAuthErrors) {
    // Every failed login counts towards an IP ban, so stop after the first one
    if (/invalid token|invalid authorization type/i.test(error)) {
      state.blockedApiKey = apiKey;
      throw new TrackerAuthError(t.id);
    }
    if (/ip address has been banned/i.test(error)) {
      state.blockedApiKey = apiKey;
      throw new TrackerAuthError(t.id, `${t.name} has banned your IP address, so requests are paused. Check your account on the site.`);
    }
    if (/insufficient privileges/i.test(error)) {
      throw new TrackerForbiddenError(t.id);
    }
  }
  if (/rate limit/i.test(error)) {
    state.pausedUntil = Math.max(state.pausedUntil, Date.now() + t.rateLimitPause);
    throw new TrackerUnavailableError(t.id);
  }
  return data;
}

// -- API layer ------------------------------------------------------

interface ArtistResponse {
  status: string;
  response: {
    id: number;
    name: string;
    torrentgroup: GazelleArtistTorrentGroup[];
    requests?: GazelleArtistRequest[];
  };
}

interface TorrentGroupResponse {
  status: string;
  response: GazelleGroupDetail;
}

interface BrowseResponse {
  status: string;
  response: {
    results: {
      groupId: number;
      groupName: string;
      artist: string;
      groupYear: number;
      releaseType: string;
      torrents: {
        torrentId: number;
        format: string;
        encoding: string;
        media: string;
        remasterTitle: string;
        remasterCatalogueNumber: string;
        remasterRecordLabel: string;
        remasterYear: number;
        remastered: boolean;
        fileCount: number;
      }[];
    }[];
  };
}

interface RequestsResponse {
  status: string;
  response: {
    results: {
      requestId: number;
      title: string;
      year: number;
      bounty: number;
      categoryId?: number;
      formatList: string[] | string;
      mediaList?: string[] | string;
      isFilled: boolean;
      groupId?: number;
    }[];
  };
}

async function fetchArtist(
  t: Tracker,
  name: string,
  apiKey: string,
): Promise<{ groups: GazelleArtistTorrentGroup[]; requests: GazelleArtistRequest[] | null }> {
  const res = await rateLimitedFetch(t, { action: 'artist', artistname: name }, apiKey);
  if (!res.ok) throw new Error(`${t.name} artist lookup failed: ${res.status}`);
  const data = await readJson<ArtistResponse>(t, res, apiKey);
  if (data.status !== 'success') return { groups: [], requests: null };
  return { groups: data.response.torrentgroup ?? [], requests: data.response.requests ?? [] };
}

async function fetchTorrentGroup(
  t: Tracker,
  groupId: number,
  apiKey: string,
): Promise<GazelleGroupDetail | null> {
  const res = await rateLimitedFetch(t, { action: 'torrentgroup', id: String(groupId) }, apiKey);
  if (!res.ok) return null;
  const data = await readJson<TorrentGroupResponse>(t, res, apiKey);
  if (data.status !== 'success') return null;
  return data.response;
}

async function browseTorrents(
  t: Tracker,
  params: Record<string, string>,
  apiKey: string,
): Promise<BrowseResponse['response']['results']> {
  const res = await rateLimitedFetch(t, { action: 'browse', ...params }, apiKey);
  if (!res.ok) throw new Error(`${t.name} API error: ${res.status}`);
  const data = await readJson<BrowseResponse>(t, res, apiKey);
  if (data.status !== 'success') return [];
  return data.response.results;
}

async function searchRequests(
  t: Tracker,
  searchTerm: string,
  apiKey: string,
): Promise<RequestsResponse['response']['results']> {
  const res = await rateLimitedFetch(t, { action: 'requests', search: searchTerm }, apiKey);
  if (!res.ok) return [];
  const data = await readJson<RequestsResponse>(t, res, apiKey);
  if (data.status !== 'success') return [];
  return data.response.results;
}

// -- Normalization utilities ----------------------------------------

/** Strip separators and the leading zeros of each number, and lowercase for catalogue number comparison. */
export function normalizeCatNo(s: string): string {
  return s.replace(/[\s\-_.\/]/g, '').replace(/(^|\D)0+(?=\d)/g, '$1').toLowerCase();
}

/** Normalize a title for comparison: lowercase, strip non-alphanumeric, collapse spaces. */
export function normalizeTitle(s: string): string {
  return decodeHtmlEntities(s)
    .replace(/&\w+;/g, '')
    .replace(/&#x?[\da-fA-F]+;/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalized title, or the plain lowercase title for titles that normalize to nothing (e.g. Japanese). */
function titleKey(s: string): string {
  return normalizeTitle(s) || decodeHtmlEntities(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Normalize a track name similarly to title, plus strip leading track numbering. */
export function normalizeTrackName(name: string): string {
  return normalizeTitle(name).replace(/^\d+\s*/, '');
}

/** Decode common HTML entities that appear in tracker API responses. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d{2,5});/g, (_, code) => String.fromCodePoint(Number(code)));
}

/** Map a single Discogs format name to the tracker's media type string. */
export function discogsFormatToMedia(t: Tracker, formatName: string): string | null {
  return t.media[formatName] ?? null;
}

/** Map Discogs format descriptions to the tracker's release type integer. */
export function discogsDescriptionsToReleaseType(t: Tracker, descriptions: string[]): number | null {
  for (const d of descriptions) {
    const rt = t.releaseTypes[d];
    if (rt !== undefined) return rt;
  }
  return null;
}

/** Convert a browse releaseType string to integer. */
function releaseTypeStringToInt(t: Tracker, s: string): number {
  const name = s.toLowerCase();
  const entry = Object.entries(t.browseReleaseTypes).find(([key]) => key.toLowerCase() === name);
  return entry?.[1] ?? 21;
}

export function isVariousArtists(artist: string): boolean {
  const lower = artist.toLowerCase().trim();
  return lower === 'various' || lower === 'various artists' || lower === 'va';
}

// -- Candidate type for matching pipeline ---------------------------

interface TorrentCandidate {
  torrentId: number;
  groupId: number;
  groupName: string;
  groupYear: number;
  media: string;
  format: string;
  encoding: string;
  remasterYear: number;
  remasterTitle: string;
  remasterRecordLabel: string;
  remasterCatalogueNumber: string;
  fileCount: number;
  fileList: string;
  description: string;
  trumpable?: boolean;
  trumpableReasons?: string[];
}

// -- Step 6: Filter by release type ---------------------------------

function filterByReleaseType(
  t: Tracker,
  groups: GazelleArtistTorrentGroup[],
  discogsFormats: DiscogsFormat[],
): GazelleArtistTorrentGroup[] {
  // Collect all descriptions across all Discogs formats
  const allDescs = discogsFormats.flatMap((f) => f.descriptions ?? []);
  const releaseType = discogsDescriptionsToReleaseType(t, allDescs);

  // Filter out artist-role entries (1021+)
  const musicGroups = groups.filter((g) => g.releaseType < 1000);

  if (releaseType === null) return musicGroups;

  // Anthology (6) and Compilation (7) are often used interchangeably.
  // Album (1) also matches Live album (11) — Discogs often tags live albums as
  // just "Album", while the trackers use the more specific "Live album" category.
  let equivalent: number[];
  if (releaseType === 6 || releaseType === 7) equivalent = [6, 7];
  else if (releaseType === 1) equivalent = [1, 11];
  else equivalent = [releaseType];

  const matched = musicGroups.filter(
    (g) => equivalent.includes(g.releaseType) || g.releaseType === 21,
  );
  // If no matches with type filter, fall back to all music groups
  return matched.length > 0 ? matched : musicGroups;
}

/** All music groups, except albums for a single or EP, which often share their name. */
function filterByReleaseTypeLoosely(
  t: Tracker,
  groups: GazelleArtistTorrentGroup[],
  discogsFormats: DiscogsFormat[],
): GazelleArtistTorrentGroup[] {
  const allDescs = discogsFormats.flatMap((f) => f.descriptions ?? []);
  const releaseType = discogsDescriptionsToReleaseType(t, allDescs);
  const musicGroups = groups.filter((g) => g.releaseType < 1000);
  if (releaseType !== 5 && releaseType !== 9) return musicGroups;
  // Album, Soundtrack, Anthology, Compilation and Live album
  return musicGroups.filter((g) => ![1, 3, 6, 7, 11].includes(g.releaseType));
}

// -- Step 7: Title matching -----------------------------------------

function matchByTitle(
  groups: GazelleArtistTorrentGroup[],
  discogsTitle: string,
): GazelleArtistTorrentGroup[] {
  const target = normalizeTitle(discogsTitle);

  // Pass 1: exact normalized match, also on each part of a Discogs title
  // given in two forms (e.g. "初恋 = Hatsukoi"), since the tracker may use either one
  const keys = [discogsTitle, ...discogsTitle.split(' = ')].map(titleKey);
  const exact = groups.filter((g) => keys.includes(titleKey(g.groupName)));
  if (exact.length > 0) return exact;

  // Pass 2: one contains the other (for subtitles, suffixes, etc.).
  // Short names have to be whole words, as they turn up inside unrelated titles.
  if (!target) return [];
  const includes = (a: string, b: string) => (b.length >= 3 ? a.includes(b) : ` ${a} `.includes(` ${b} `));
  const contains = groups.filter((g) => {
    const norm = normalizeTitle(g.groupName);
    return norm !== '' && (includes(norm, target) || includes(target, norm));
  });
  return contains;
}

// -- Steps 8–9: Successive narrowing --------------------------------

function filterByMedia(
  t: Tracker,
  candidates: TorrentCandidate[],
  release: DiscogsReleaseDetail,
): TorrentCandidate[] {
  const formatName = release.formats[0]?.name;
  if (!formatName) return candidates;
  const media = discogsFormatToMedia(t, formatName);
  if (!media) return candidates;
  return candidates.filter((c) => c.media === media);
}

function filterByTrackCount(
  candidates: TorrentCandidate[],
  release: DiscogsReleaseDetail,
): TorrentCandidate[] {
  // With several formats (e.g. CD + DVD) the tracklist isn't all on one torrent
  if (release.formats.length !== 1) return candidates;
  const trackCount = filterAudioTracks(release.tracklist).length;
  // Bonus tracks make a different edition, so skip editions with clearly fewer files
  return candidates.filter((c) => {
    const fileCount = parseFileList(c.fileList).length;
    return fileCount === 0 || fileCount > trackCount - 2;
  });
}

function filterByCatalogueNumber(
  candidates: TorrentCandidate[],
  release: DiscogsReleaseDetail,
): TorrentCandidate[] {
  const discogsCatNos = release.labels.map((l) => l.catno).filter(Boolean);
  if (discogsCatNos.length === 0) return candidates;

  // Pass 1: exact normalized match
  const exact = candidates.filter((c) => {
    if (!c.remasterCatalogueNumber) return false;
    const normTracker = normalizeCatNo(c.remasterCatalogueNumber);
    return discogsCatNos.some((catno) => normalizeCatNo(catno) === normTracker);
  });
  if (exact.length > 0) return exact;

  // Pass 2: loose substring match (bidirectional), skipping short values
  // that turn up inside unrelated catalogue numbers and barcodes
  const loose = candidates.filter((c) => {
    if (!c.remasterCatalogueNumber) return false;
    const normTracker = normalizeCatNo(c.remasterCatalogueNumber);
    if (!normTracker) return false;
    return discogsCatNos.some((catno) => {
      const normDisc = normalizeCatNo(catno);
      if (Math.min(normTracker.length, normDisc.length) < 4) return false;
      return normTracker.includes(normDisc) || normDisc.includes(normTracker);
    }) || (release.barcode && /^\d{6,}$/.test(normTracker) && (
      normTracker.includes(normalizeCatNo(release.barcode)) ||
      normalizeCatNo(release.barcode).includes(normTracker)
    ));
  });
  if (loose.length > 0) return loose;

  // Pass 3: also match candidates with empty catno (original releases)
  // If no candidates matched, include the originals that may not have catalogue numbers set
  const originals = candidates.filter((c) => !c.remasterCatalogueNumber);
  return originals.length > 0 ? originals : candidates;
}

function filterByLabel(
  candidates: TorrentCandidate[],
  release: DiscogsReleaseDetail,
): TorrentCandidate[] {
  const discogsLabels = release.labels.map((l) => l.name.toLowerCase()).filter(Boolean);
  if (discogsLabels.length === 0) return candidates;

  const matched = candidates.filter((c) => {
    const label = (c.remasterRecordLabel || '').toLowerCase();
    if (!label) return false;
    return discogsLabels.some((dl) => label.includes(dl) || dl.includes(label));
  });
  return matched.length > 0 ? matched : candidates;
}

function filterByEditionTitle(
  candidates: TorrentCandidate[],
  release: DiscogsReleaseDetail,
): TorrentCandidate[] {
  const descriptions = release.formats.flatMap((f) => f.descriptions ?? []);
  // Only use descriptors that are meaningful for edition matching
  const meaningful = descriptions.filter(
    (d) => !['Album', 'Single', 'EP', 'Compilation', 'LP', 'Stereo', 'Mono'].includes(d),
  );
  if (meaningful.length === 0) return candidates;

  const matched = candidates.filter((c) => {
    const title = c.remasterTitle.toLowerCase();
    return meaningful.some((d) => title.includes(d.toLowerCase()));
  });
  return matched.length > 0 ? matched : candidates;
}

function filterByYear(
  t: Tracker,
  candidates: TorrentCandidate[],
  release: DiscogsReleaseDetail,
): TorrentCandidate[] {
  if (!release.year) return candidates;

  const matched = candidates.filter((c) => {
    const year = c.remasterYear || (t.editionYearFallback ? c.groupYear : 0);
    return year === release.year;
  });
  return matched.length > 0 ? matched : candidates;
}

type NarrowResult =
  | { result: 'single'; candidate: TorrentCandidate }
  | { result: 'zero' }
  | { result: 'multiple'; candidates: TorrentCandidate[] };

function editionKeyOf(c: TorrentCandidate): string {
  return `${c.groupId}|${c.media}|${c.remasterYear}|${c.remasterTitle}|${c.remasterRecordLabel}|${c.remasterCatalogueNumber}`;
}

function narrowCandidates(
  t: Tracker,
  candidates: TorrentCandidate[],
  release: DiscogsReleaseDetail,
): NarrowResult {
  const steps: ((cs: TorrentCandidate[]) => TorrentCandidate[])[] = [
    // Track count goes with media, since an edition left on its own after any step is accepted
    (cs) => filterByTrackCount(filterByMedia(t, cs, release), release),
    (cs) => filterByCatalogueNumber(cs, release),
    (cs) => filterByLabel(cs, release),
    (cs) => filterByEditionTitle(cs, release),
    (cs) => filterByYear(t, cs, release),
  ];

  let current = candidates;
  for (const step of steps) {
    const next = step(current);
    if (next.length === 0) return { result: 'zero' };
    current = next;
    // Check if all remaining candidates belong to the same edition
    const editions = new Set(current.map(editionKeyOf));
    if (editions.size === 1) return { result: 'single', candidate: current[0]! };
  }

  return { result: 'multiple', candidates: current };
}

// -- Steps 10–11: Track matching ------------------------------------

/** Parse a torrent fileList into audio file names. */
function parseFileList(fileList: string): string[] {
  if (!fileList) return [];
  const audioExts = /\.(flac|mp3|ogg|opus|m4a|aac|wav|ape|wv|alac)$/i;
  return fileList
    .split('|||')
    .map((entry) => entry.replace(/\{\{\{\d+\}\}\}/, '').trim())
    .filter((name) => audioExts.test(name))
    .map((name) => {
      // Strip directory prefix and extension, then strip leading track numbers
      const base = name.replace(/.*\//, '').replace(/\.[^.]+$/, '');
      return base
        .replace(/^\d+[\s._-]+/, '') // "01 - Track" -> "Track"
        .replace(/^\d+\s*/, '')      // "01Track" -> "Track"
        .trim();
    });
}

/** Parse track listings from a group description (BBCode/HTML). */
function parseDescriptionTracks(
  description: string,
): { name: string; durationSeconds: number | null }[] {
  if (!description) return [];

  const decoded = decodeHtmlEntities(description);
  // Strip BBCode/HTML tags
  const stripped = decoded
    .replace(/\[\/?\w+\]/g, '')
    .replace(/<[^>]+>/g, '');

  const tracks: { name: string; durationSeconds: number | null }[] = [];

  // Match patterns like: "1. Track Name (3:45)" or "01 - Track Name [3:45]"
  const linePattern = /^\s*(?:\d+[\s.)\-]+)(.+?)(?:\s*[\[(](\d+:\d+)[\])]\s*)?$/;
  for (const line of stripped.split('\n')) {
    const m = line.match(linePattern);
    if (m) {
      const name = m[1]!.trim();
      if (name.length > 0) {
        tracks.push({
          name,
          durationSeconds: m[2] ? parseDuration(m[2]) : null,
        });
      }
    }
  }

  return tracks;
}

/**
 * Check if two track listings match, ignoring order.
 * Uses bijective name matching and uniform-offset duration checking.
 */
function trackListingsMatch(
  discogsTracks: { name: string; durationSeconds: number | null }[],
  trackerTracks: { name: string }[],
  _mediaType: string,
): boolean {
  if (discogsTracks.length === 0 || trackerTracks.length === 0) return false;
  // The tracker should have at least as many tracks
  if (trackerTracks.length < discogsTracks.length) return false;

  // Try to match each Discogs track to a tracker track by name
  const usedIndices = new Set<number>();
  const normNames = trackerTracks.map((t) => normalizeTrackName(t.name));
  let matchedCount = 0;

  for (const dTrack of discogsTracks) {
    const normDiscogs = normalizeTrackName(dTrack.name);
    if (!normDiscogs) continue;
    let bestIdx = -1;
    let bestScore = 0;

    for (let i = 0; i < normNames.length; i++) {
      if (usedIndices.has(i)) continue;
      const norm = normNames[i]!;
      if (!norm) continue;

      // Exact match
      if (norm === normDiscogs) {
        bestIdx = i;
        bestScore = 3;
        break;
      }
      // One contains the other
      if ((norm.includes(normDiscogs) || normDiscogs.includes(norm)) && bestScore < 2) {
        bestIdx = i;
        bestScore = 2;
      }
    }

    if (bestIdx >= 0) {
      usedIndices.add(bestIdx);
      matchedCount++;
    }
  }

  // Require at least 80% of Discogs tracks to match
  return matchedCount >= discogsTracks.length * 0.8;
}

/**
 * Step 10: Try to match against track listings from the tracker's torrent groups.
 * Checks file lists and group descriptions for track data.
 */
function matchByTrackListing(
  t: Tracker,
  release: DiscogsReleaseDetail,
  groupDetails: GazelleGroupDetail[],
): TorrentCandidate[] {
  const audioTracks = filterAudioTracks(release.tracklist);
  if (audioTracks.length === 0) return [];

  const discogsTracks = audioTracks.map((t) => ({
    name: t.title,
    durationSeconds: parseDuration(t.duration),
  }));

  const formatName = release.formats[0]?.name ?? 'CD';
  const media = discogsFormatToMedia(t, formatName) ?? 'CD';
  const matched: TorrentCandidate[] = [];

  for (const group of groupDetails) {
    // Try matching against group description track listing
    const descTracks = parseDescriptionTracks(group.group.bbBody || group.group.wikiBBcode || group.group.wikiBody || '');

    for (const torrent of group.torrents) {
      // Filter by media first
      if (torrent.media !== media) continue;

      // Try file list track names
      const fileTrackNames = parseFileList(torrent.fileList);
      if (fileTrackNames.length > 0) {
        const trackerTracks = fileTrackNames.map((name) => ({ name }));
        if (trackListingsMatch(discogsTracks, trackerTracks, media)) {
          matched.push(torrentToCandidate(torrent, group));
          continue;
        }
      }

      // Try description tracks (shared across all torrents in group)
      if (descTracks.length > 0) {
        if (trackListingsMatch(discogsTracks, descTracks, media)) {
          matched.push(torrentToCandidate(torrent, group));
          continue;
        }
      }

      // If track count matches and we have no better data, count as match
      if (fileTrackNames.length === 0 && descTracks.length === 0 && torrent.fileCount >= audioTracks.length) {
        matched.push(torrentToCandidate(torrent, group));
      }
    }
  }

  return matched;
}

function torrentToCandidate(torrent: GazelleGroupTorrent, group: GazelleGroupDetail): TorrentCandidate {
  return {
    torrentId: torrent.id,
    groupId: group.group.id,
    groupName: group.group.name,
    groupYear: group.group.year,
    media: torrent.media,
    format: torrent.format,
    encoding: torrent.encoding,
    remasterYear: torrent.remasterYear ?? 0,
    remasterTitle: torrent.remasterTitle,
    remasterRecordLabel: torrent.remasterRecordLabel,
    remasterCatalogueNumber: torrent.remasterCatalogueNumber,
    fileCount: torrent.fileCount,
    fileList: torrent.fileList,
    description: torrent.description,
    trumpable: torrent.trumpable,
    trumpableReasons: torrent.trumpable_reasons,
  };
}

// -- Edition counting -----------------------------------------------

function countOtherEditions(
  matched: TorrentCandidate,
  allCandidates: TorrentCandidate[],
): number {
  const matchedKey = editionKeyOf(matched);
  const otherKeys = new Set<string>();

  for (const c of allCandidates) {
    const key = editionKeyOf(c);
    if (key !== matchedKey) otherKeys.add(key);
  }

  return otherKeys.size;
}

// -- Request matching -----------------------------------------------

/** Join a request's format list for display. */
function listText(list: string[] | string): string {
  return Array.isArray(list) ? list.join(' / ') : list;
}

/** Keep the open music requests that this release could fill. */
function matchRequests(
  t: Tracker,
  results: RequestsResponse['response']['results'],
  release: DiscogsReleaseDetail,
  title: string,
  groupId?: number,
): TrackerRequest[] {
  const media = discogsFormatToMedia(t, release.formats[0]?.name ?? '');
  const key = titleKey(title);
  return results
    .filter((r) => !r.isFilled)
    .filter((r) => r.categoryId === undefined || r.categoryId === 1)
    .filter((r) => !media || !Array.isArray(r.mediaList) || r.mediaList.length === 0 ||
      r.mediaList.includes(media) || r.mediaList.includes('Any'))
    .filter((r) => {
      if (groupId !== undefined && r.groupId === groupId) return true;
      // Otherwise the title has to match, and the request can't be for another group
      return (groupId === undefined || !r.groupId) && titleKey(r.title) === key;
    })
    .map((r) => ({
      requestId: r.requestId,
      title: r.title,
      year: r.year,
      bounty: r.bounty,
      formatList: listText(r.formatList),
    }));
}

/** Keep the artist's open music requests with this title. They don't list formats or media. */
function matchArtistRequests(requests: GazelleArtistRequest[], title: string): TrackerRequest[] {
  const key = titleKey(title);
  return requests
    .filter((r) => r.categoryId === undefined || r.categoryId === 1)
    .filter((r) => titleKey(r.title) === key)
    .map((r) => ({
      requestId: r.requestId,
      title: r.title,
      year: r.year,
      bounty: r.bounty,
      formatList: '',
    }));
}

/** Search requests and keep those for a specific group. */
async function fetchRequestsForGroup(
  t: Tracker,
  release: DiscogsReleaseDetail,
  groupName: string,
  groupId: number,
  apiKey: string,
): Promise<TrackerRequest[]> {
  // Include the artist, since requests that aren't linked to the group are matched by title.
  // Not for several artists, as the search needs every word and "Feat." may not be there.
  const name = decodeHtmlEntities(groupName);
  const term = isVariousArtists(release.artistDisplay) || release.artists.length > 1
    ? name
    : `${release.artistDisplay} ${name}`;
  const results = await searchRequests(t, term, apiKey).catch((err) => {
    if (isTrackerError(err)) throw err;
    return [];
  });
  return matchRequests(t, results, release, groupName, groupId);
}

// -- Main orchestrator (steps 5–11) ---------------------------------

/**
 * Whether the matched edition still has no lossless torrent (24-bit counts too),
 * and whether the tracker marked all of its lossless torrents trumpable.
 * On trackers where that only means reported, the reasons are returned instead.
 */
function editionLossless(
  t: Tracker,
  matched: TorrentCandidate,
  allCandidates: TorrentCandidate[],
): { losslessMissing: boolean; trumpable: boolean; reported?: string[] } {
  const key = editionKeyOf(matched);
  const lossless = allCandidates.filter(
    (c) => editionKeyOf(c) === key && c.encoding.includes('Lossless'),
  );
  const flagged = lossless.length > 0 && lossless.every((c) => c.trumpable);
  if (t.trumpableMeansReported) {
    const reasons = [...new Set(lossless.flatMap((c) => c.trumpableReasons ?? []))];
    return { losslessMissing: lossless.length === 0, trumpable: false, reported: flagged ? reasons : undefined };
  }
  return {
    losslessMissing: lossless.length === 0,
    trumpable: flagged,
  };
}

function makeResult(
  result: TrackerMatchResult,
  otherEditionCount: number,
  requests: TrackerRequest[],
  trumpable = false,
  losslessMissing = false,
  matchedGroupId?: number,
  matchedTorrentId?: number,
  reported?: string[],
): TrackerStatus {
  return {
    result,
    uploaded: result === 'uploaded',
    trumpable,
    reported,
    losslessMissing,
    otherEditionCount,
    requestCount: requests.length,
    requests,
    checkedAt: Date.now(),
    matchedGroupId,
    matchedTorrentId,
  };
}

export async function getTrackerStatus(
  tracker: TrackerId,
  release: DiscogsReleaseDetail,
  apiKey: string,
): Promise<TrackerStatus> {
  const t = TRACKERS[tracker];
  const artist = release.artistDisplay;
  const title = release.title;

  // Step 5: Look up artist (or browse for VA releases)
  let groups: GazelleArtistTorrentGroup[];
  // Browsed groups that are credited to Various Artists
  const vaGroupIds = new Set<number>();
  // The open requests from the artist responses, on trackers that list them
  let artistRequests: GazelleArtistRequest[] | null = null;
  const addArtistRequests = (requests: GazelleArtistRequest[] | null) => {
    if (!t.artistRequests || !requests) return;
    const known = new Set((artistRequests ?? []).map((r) => r.requestId));
    artistRequests = [...(artistRequests ?? []), ...requests.filter((r) => !known.has(r.requestId))];
  };

  if (isVariousArtists(artist)) {
    // Fallback: browse by title for Various Artists
    const browseResults = await browseTorrents(t, { [t.browseTitleParam]: title }, apiKey);
    for (const r of browseResults) {
      if (isVariousArtists(decodeHtmlEntities(r.artist))) vaGroupIds.add(r.groupId);
    }
    groups = browseResults.map((r) => ({
      groupId: r.groupId,
      groupName: r.groupName,
      groupYear: r.groupYear,
      groupRecordLabel: '',
      groupCatalogueNumber: '',
      releaseType: releaseTypeStringToInt(t, r.releaseType),
      torrent: r.torrents.map((t) => ({
        id: t.torrentId,
        groupId: r.groupId,
        media: t.media,
        format: t.format,
        encoding: t.encoding,
        remasterYear: t.remasterYear,
        remastered: t.remastered,
        remasterTitle: t.remasterTitle,
        remasterRecordLabel: t.remasterRecordLabel,
        fileCount: t.fileCount,
      })),
    }));
  } else if (release.artists.length > 1) {
    // Multi-artist: look up each artist individually and merge groups.
    // Deduplicate by groupId, preferring the entry with the lowest releaseType
    // (the artist endpoint uses releaseType >= 1000 for non-main roles like
    // Guest Appearance, so we need the main-artist entry to survive filtering)
    const groupMap = new Map<number, GazelleArtistTorrentGroup>();

    for (const artistCredit of release.artists) {
      const name = artistCredit.anv || stripDiscogsDisambiguator(artistCredit.name);
      try {
        const data = await fetchArtist(t, name, apiKey);
        addArtistRequests(data.requests);
        for (const group of data.groups) {
          const existing = groupMap.get(group.groupId);
          if (!existing || group.releaseType < existing.releaseType) {
            groupMap.set(group.groupId, group);
          }
        }
      } catch (err) {
        if (isTrackerError(err)) throw err;
        // Individual artist not found - continue with remaining artists
      }
    }

    if (groupMap.size === 0 && artistRequests) {
      return makeResult('not_uploaded', 0, matchArtistRequests(artistRequests, title));
    }
    if (groupMap.size === 0) {
      const requestResults = await searchRequests(t, `${artist} ${title}`, apiKey).catch((e) => {
        if (isTrackerError(e)) throw e;
        return [];
      });
      const requests = matchRequests(t, requestResults, release, title);
      return makeResult('not_uploaded', 0, requests);
    }

    // Remap artist-role releaseTypes (>=1000, e.g. Guest Appearance) to Unknown (21).
    // The artist endpoint overloads releaseType for the artist's role on collaborative
    // releases, hiding the real group type. Unknown passes through filterByReleaseType
    // so title matching can determine relevance.
    groups = [...groupMap.values()].map((g) =>
      g.releaseType >= 1000 ? { ...g, releaseType: 21 } : g,
    );
  } else {
    try {
      const artistData = await fetchArtist(t, artist, apiKey);
      groups = artistData.groups;
      addArtistRequests(artistData.requests);
    } catch (err) {
      if (isTrackerError(err)) throw err;
      // Artist not found on the tracker - search requests as fallback
      const requestResults = await searchRequests(t, `${artist} ${title}`, apiKey).catch((e) => {
        if (isTrackerError(e)) throw e;
        return [];
      });
      const requests = matchRequests(t, requestResults, release, title);
      return makeResult('not_uploaded', 0, requests);
    }
  }

  // Helper: search requests (general text search, no group filter)
  const searchFallbackRequests = async () => {
    if (artistRequests) return matchArtistRequests(artistRequests, title);
    const term = isVariousArtists(artist) ? title : `${artist} ${title}`;
    const results = await searchRequests(t, term, apiKey).catch((e) => {
      if (isTrackerError(e)) throw e;
      return [];
    });
    return matchRequests(t, results, release, title);
  };

  // Step 6: Filter by release type
  const typeFiltered = filterByReleaseType(t, groups, release.formats);

  // Step 7: Title match. Discogs and the tracker don't always agree on the release type
  // (e.g. soundtracks are just "Album" on Discogs), so retry with a looser filter.
  let titleMatches = matchByTitle(typeFiltered, title);
  if (titleMatches.length === 0) {
    titleMatches = matchByTitle(filterByReleaseTypeLoosely(t, groups, release.formats), title);
  }
  // Browsing finds the title for any artist, so prefer matches credited to Various Artists.
  // Others are kept when there are none, since DJ mixes are listed under the DJ.
  const vaMatches = titleMatches.filter((g) => vaGroupIds.has(g.groupId));
  if (vaMatches.length > 0) titleMatches = vaMatches;
  if (titleMatches.length === 0) {
    const requests = await searchFallbackRequests();
    return makeResult('not_uploaded', 0, requests);
  }

  // Phase 2: Fetch torrentgroup details for matched groups
  // This gives us remasterCatalogueNumber, fileList, description
  const groupDetailCache = new Map<number, GazelleGroupDetail>();
  const allCandidates: TorrentCandidate[] = [];

  for (const group of titleMatches.slice(0, MAX_GROUP_FETCHES)) {
    const detail = await fetchTorrentGroup(t, group.groupId, apiKey);
    if (!detail) continue;
    groupDetailCache.set(group.groupId, detail);

    for (const torrent of detail.torrents) {
      allCandidates.push(torrentToCandidate(torrent, detail));
    }
  }

  if (allCandidates.length === 0) {
    const requests = await searchFallbackRequests();
    return makeResult('not_uploaded', 0, requests);
  }

  const requestsForGroup = (c: TorrentCandidate) => (artistRequests
    ? Promise.resolve(matchArtistRequests(artistRequests, c.groupName))
    : fetchRequestsForGroup(t, release, c.groupName, c.groupId, apiKey));

  // Step 8: Successive narrowing
  const narrowResult = narrowCandidates(t, allCandidates, release);

  if (narrowResult.result === 'single') {
    const otherEditions = countOtherEditions(narrowResult.candidate, allCandidates);
    const { losslessMissing, trumpable, reported } = editionLossless(t, narrowResult.candidate, allCandidates);
    const requests = await requestsForGroup(narrowResult.candidate);
    return makeResult('uploaded', otherEditions, requests, trumpable, losslessMissing, narrowResult.candidate.groupId, narrowResult.candidate.torrentId, reported);
  }

  // Steps 10–11: Track matching (for both 'zero' and 'multiple' outcomes)
  const groupDetails = [...groupDetailCache.values()];
  const trackMatches = matchByTrackListing(t, release, groupDetails);

  if (trackMatches.length >= 1) {
    const otherEditions = countOtherEditions(trackMatches[0]!, allCandidates);
    const { losslessMissing, trumpable, reported } = editionLossless(t, trackMatches[0]!, allCandidates);
    const requests = await requestsForGroup(trackMatches[0]!);
    return makeResult('uploaded', otherEditions, requests, trumpable, losslessMissing, trackMatches[0]!.groupId, trackMatches[0]!.torrentId, reported);
  }

  // If title matched with multiple editions, treat as already on the tracker
  if (narrowResult.result === 'multiple') {
    const otherEditions = countOtherEditions(narrowResult.candidates[0]!, allCandidates);
    const { losslessMissing, trumpable, reported } = editionLossless(t, narrowResult.candidates[0]!, allCandidates);
    const requests = await requestsForGroup(narrowResult.candidates[0]!);
    return makeResult('uploaded', otherEditions, requests, trumpable, losslessMissing, narrowResult.candidates[0]!.groupId, narrowResult.candidates[0]!.torrentId, reported);
  }

  const requests = await searchFallbackRequests();
  const otherEditions = new Set(allCandidates.map(editionKeyOf)).size;
  return makeResult('not_uploaded', otherEditions, requests);
}
