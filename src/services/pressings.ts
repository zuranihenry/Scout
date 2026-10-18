import type { DiscogsSearchResult, DiscogsReleaseDetail } from '../types';
import { stripDiscogsDisambiguator } from './discogs';

// -- Popularity -----------------------------------------------------

/** Most owned first. Releases without a count keep Discogs' order at the end. */
export function sortByPopularity(candidates: DiscogsSearchResult[]): DiscogsSearchResult[] {
  return candidates
    .map((c, i) => ({ c, i, have: c.community?.have ?? -1 }))
    .sort((a, b) => b.have - a.have || a.i - b.i)
    .map(({ c }) => c);
}

/** The release most users have, or null when nothing has a count or the top is a tie. */
export function mostCommonId(candidates: DiscogsSearchResult[]): number | null {
  let bestId: number | null = null;
  let bestHave = 0;
  let tie = false;
  for (const c of candidates) {
    const have = c.community?.have ?? 0;
    if (have > bestHave) {
      bestId = c.id;
      bestHave = have;
      tie = false;
    } else if (have > 0 && have === bestHave) {
      tie = true;
    }
  }
  return tie ? null : bestId;
}

// -- Shared and differing details -----------------------------------

export type PressingDetailKey = 'label' | 'catno' | 'format' | 'country' | 'year';

export interface PressingDetail {
  key: PressingDetailKey;
  value: string;
}

function pressingDetails(c: DiscogsSearchResult): PressingDetail[] {
  const labels = [...new Set((c.label ?? []).map(stripDiscogsDisambiguator).filter(Boolean))];
  return [
    { key: 'label', value: labels.join(', ') },
    { key: 'catno', value: c.catno ?? '' },
    { key: 'format', value: (c.format ?? []).join(', ') },
    { key: 'country', value: c.country ?? '' },
    { key: 'year', value: c.year ?? '' },
  ];
}

/** Details that have the same value in every candidate. */
export function sharedDetails(candidates: DiscogsSearchResult[]): PressingDetail[] {
  if (candidates.length < 2) return [];
  const all = candidates.map(pressingDetails);
  return all[0]!.filter((d, i) => d.value && all.every((details) => details[i]!.value === d.value));
}

/** A candidate's details, leaving out the ones every candidate shares. */
export function differingDetails(
  candidate: DiscogsSearchResult,
  shared: PressingDetail[],
): PressingDetail[] {
  return pressingDetails(candidate).filter(
    (d) => d.value && !shared.some((s) => s.key === d.key),
  );
}

// -- Search result helpers ------------------------------------------

/** Values for the Format filter: every media name and description, e.g. "Vinyl", "Reissue". */
export function formatNames(c: DiscogsSearchResult): string[] {
  return [...new Set([...(c.formats ?? []).map((f) => f.name), ...(c.format ?? [])])];
}

/** The search result's own image, ignoring Discogs' blank placeholder. */
export function searchImage(c: DiscogsSearchResult): string {
  const image = c.thumb || c.cover_image;
  return image && !image.includes('spacer.gif') ? image : '';
}

// -- Disc search ----------------------------------------------------

/** Lowercase without spaces or punctuation, so "AL-8405-A Rev. #1" contains "arev1". */
function compact(s: string): string {
  return s.toLowerCase().replace(/[^0-9a-z\u00c0-\u1fff\u2070-\uffff]/g, '');
}

/** Whether text read off the disc appears in the search result or its loaded details. */
export function matchesDiscQuery(
  candidate: DiscogsSearchResult,
  detail: DiscogsReleaseDetail | undefined,
  query: string,
): boolean {
  const q = compact(query);
  if (!q) return true;
  const fields: (string | undefined)[] = [
    ...(candidate.barcode ?? []),
    candidate.catno,
    ...(candidate.label ?? []),
    ...(candidate.format ?? []),
    ...(candidate.formats ?? []).map((f) => f.text),
    candidate.country,
  ];
  if (detail) {
    for (const i of detail.identifiers) fields.push(i.value, i.description);
    for (const l of detail.labels) fields.push(l.catno);
    for (const f of detail.formats) fields.push(f.text, ...(f.descriptions ?? []));
    fields.push(detail.notes);
  }
  return fields.some((f) => !!f && compact(f).includes(q));
}
