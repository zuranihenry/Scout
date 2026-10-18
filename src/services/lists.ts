import type { Album, AlbumList } from '../types';

export const DEFAULT_LIST_ID = 'collection';
export const DEFAULT_LIST: AlbumList = { id: DEFAULT_LIST_ID, name: 'Collection' };

export function albumListId(album: Album): string {
  return album.listId ?? DEFAULT_LIST_ID;
}

/** A copy of the album in another list. Albums in Collection have no listId. */
export function withListId(album: Album, listId: string): Album {
  const next: Album = { ...album, listId };
  if (listId === DEFAULT_LIST_ID) delete next.listId;
  return next;
}

/**
 * Move an album within one list. from and to are positions in that list, and
 * albums in other lists keep their places in the full array.
 */
export function reorderInList(albums: Album[], listId: string, from: number, to: number): Album[] {
  const slots: number[] = [];
  albums.forEach((album, i) => {
    if (albumListId(album) === listId) slots.push(i);
  });
  if (from === to || from < 0 || to < 0 || from >= slots.length || to >= slots.length) return albums;
  const listAlbums = slots.map((i) => albums[i]);
  const [item] = listAlbums.splice(from, 1);
  listAlbums.splice(to, 0, item);
  const result = [...albums];
  slots.forEach((slot, i) => {
    result[slot] = listAlbums[i];
  });
  return result;
}

/** Move albums to the top of another list. */
export function moveAlbumsToList(albums: Album[], ids: ReadonlySet<string>, listId: string): Album[] {
  const moved: Album[] = [];
  const rest: Album[] = [];
  for (const album of albums) {
    if (ids.has(album.id) && albumListId(album) !== listId) moved.push(withListId(album, listId));
    else rest.push(album);
  }
  return moved.length > 0 ? [...moved, ...rest] : albums;
}
