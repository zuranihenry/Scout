import React, { createContext, useContext, useEffect, useReducer, useRef, useCallback, useMemo } from 'react';
import * as Crypto from 'expo-crypto';
import type { Album, AlbumList } from '../types';
import { loadCollection, saveCollection, loadLists, saveLists } from '../services/storage';
import { DEFAULT_LIST, DEFAULT_LIST_ID, moveAlbumsToList, reorderInList, withListId } from '../services/lists';

type Action =
  | { type: 'SET_ALBUMS'; payload: Album[] }
  | { type: 'ADD_ALBUM'; payload: Album }
  | { type: 'REMOVE_ALBUMS'; payload: string[] }
  | { type: 'REORDER'; payload: { listId: string; from: number; to: number } }
  | { type: 'UPDATE_ALBUM'; payload: { id: string; changes: Partial<Album> } }
  | { type: 'MOVE_ALBUMS'; payload: { ids: string[]; listId: string } }
  | { type: 'DELETE_LIST'; payload: string };

interface CollectionContextValue {
  albums: Album[];
  lists: AlbumList[];  // Collection first, then the custom lists
  lastListId: string;
  isLoading: boolean;
  loadError: boolean;
  addAlbum: (album: Album, listId?: string) => void;
  removeAlbums: (ids: string[]) => void;
  reorder: (listId: string, from: number, to: number) => void;
  updateAlbum: (id: string, changes: Partial<Album>) => void;
  moveAlbums: (ids: string[], listId: string) => void;
  createList: (name: string) => AlbumList;
  renameList: (id: string, name: string) => void;
  deleteList: (id: string) => void;
  findBarcode: (barcode: string) => Album | undefined;
}

const CollectionContext = createContext<CollectionContextValue | null>(null);

function reducer(state: Album[], action: Action): Album[] {
  switch (action.type) {
    case 'SET_ALBUMS':
      return action.payload;
    case 'ADD_ALBUM':
      return [action.payload, ...state];
    case 'REMOVE_ALBUMS': {
      const ids = new Set(action.payload);
      return state.filter((a) => !ids.has(a.id));
    }
    case 'REORDER':
      return reorderInList(state, action.payload.listId, action.payload.from, action.payload.to);
    case 'UPDATE_ALBUM':
      return state.map((a) =>
        a.id === action.payload.id ? { ...a, ...action.payload.changes } : a,
      );
    case 'MOVE_ALBUMS':
      return moveAlbumsToList(state, new Set(action.payload.ids), action.payload.listId);
    case 'DELETE_LIST': {
      const ids = new Set(state.filter((a) => a.listId === action.payload).map((a) => a.id));
      return moveAlbumsToList(state, ids, DEFAULT_LIST_ID);
    }
  }
}

export function CollectionProvider({ children }: { children: React.ReactNode }) {
  const [albums, dispatch] = useReducer(reducer, []);
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [customLists, setCustomLists] = React.useState<AlbumList[]>([]);
  const [lastListId, setLastListId] = React.useState(DEFAULT_LIST_ID);
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    Promise.all([loadCollection(), loadLists()]).then(([data, stored]) => {
      // Releases of a list that wasn't saved show in Collection
      const listIds = new Set(stored.lists.map((l) => l.id));
      dispatch({
        type: 'SET_ALBUMS',
        payload: data.map((a) => (a.listId && !listIds.has(a.listId) ? withListId(a, DEFAULT_LIST_ID) : a)),
      });
      setCustomLists(stored.lists);
      setLastListId(stored.lastListId);
      setIsLoading(false);
      initialized.current = true;
    }).catch((e) => {
      // Saving stays off so the stored collection is never overwritten
      console.warn('Failed to load collection', e);
      setLoadError(true);
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!initialized.current) return;
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      saveCollection(albums).catch((e) => console.warn('Failed to save collection', e));
    }, 300);
    return () => {
      if (saveTimeout.current) clearTimeout(saveTimeout.current);
    };
  }, [albums]);

  useEffect(() => {
    if (!initialized.current) return;
    saveLists({ lists: customLists, lastListId }).catch((e) => console.warn('Failed to save lists', e));
  }, [customLists, lastListId]);

  const lists = useMemo(() => [DEFAULT_LIST, ...customLists], [customLists]);

  const addAlbum = useCallback((album: Album, listId = DEFAULT_LIST_ID) => {
    dispatch({ type: 'ADD_ALBUM', payload: withListId(album, listId) });
    setLastListId(listId);
  }, []);

  const removeAlbums = useCallback((ids: string[]) => {
    dispatch({ type: 'REMOVE_ALBUMS', payload: ids });
  }, []);

  const reorder = useCallback((listId: string, from: number, to: number) => {
    dispatch({ type: 'REORDER', payload: { listId, from, to } });
  }, []);

  const updateAlbum = useCallback((id: string, changes: Partial<Album>) => {
    dispatch({ type: 'UPDATE_ALBUM', payload: { id, changes } });
  }, []);

  const moveAlbums = useCallback((ids: string[], listId: string) => {
    dispatch({ type: 'MOVE_ALBUMS', payload: { ids, listId } });
  }, []);

  const createList = useCallback((name: string) => {
    const list = { id: Crypto.randomUUID(), name: name.trim() };
    setCustomLists((prev) => [...prev, list]);
    return list;
  }, []);

  const renameList = useCallback((id: string, name: string) => {
    setCustomLists((prev) => prev.map((l) => (l.id === id ? { ...l, name: name.trim() } : l)));
  }, []);

  // The list's releases move to Collection
  const deleteList = useCallback((id: string) => {
    dispatch({ type: 'DELETE_LIST', payload: id });
    setCustomLists((prev) => prev.filter((l) => l.id !== id));
    setLastListId((prev) => (prev === id ? DEFAULT_LIST_ID : prev));
  }, []);

  const findBarcode = useCallback(
    (barcode: string) => albums.find((a) => a.barcode === barcode),
    [albums],
  );

  return (
    <CollectionContext.Provider
      value={{
        albums,
        lists,
        lastListId,
        isLoading,
        loadError,
        addAlbum,
        removeAlbums,
        reorder,
        updateAlbum,
        moveAlbums,
        createList,
        renameList,
        deleteList,
        findBarcode,
      }}
    >
      {children}
    </CollectionContext.Provider>
  );
}

export function useCollection() {
  const ctx = useContext(CollectionContext);
  if (!ctx) throw new Error('useCollection must be used within CollectionProvider');
  return ctx;
}
