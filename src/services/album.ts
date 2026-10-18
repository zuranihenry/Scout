import type { Album, DiscogsSearchResult, DiscogsReleaseDetail } from '../types';
import { parseArtistTitle } from './discogs';
import { searchImage } from './pressings';

/** The album fields that come from a Discogs release. */
export function albumFromRelease(
  hit: DiscogsSearchResult,
  detail: DiscogsReleaseDetail | null,
): Omit<Album, 'id' | 'barcode' | 'addedAt'> {
  const { artist, title } = detail
    ? { artist: detail.artistDisplay, title: detail.title }
    : parseArtistTitle(hit.title);
  // Use the release's own image when the search result has none
  const images = searchImage(hit) ? [] : detail?.images ?? [];
  const primary = images.find((img) => img.type === 'primary') ?? images[0];
  return {
    discogsId: detail?.id ?? hit.id,
    title,
    artist,
    year: detail?.year ?? (hit.year ? parseInt(hit.year, 10) : null),
    thumb: primary ? primary.uri150 ?? '' : hit.thumb,
    coverImage: primary ? primary.uri ?? '' : hit.cover_image,
    genre: hit.genre || [],
    format: hit.format || [],
    catalogNumber: detail?.labels[0]?.catno ?? hit.catno ?? '',
    country: detail?.country,
  };
}
