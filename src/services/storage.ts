import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Album, Settings, StoredLists } from '../types';
import { DEFAULT_LIST_ID } from './lists';

const COLLECTION_KEY = 'scout_collection';
const SETTINGS_KEY = 'scout_settings';
const LISTS_KEY = 'scout_lists';

export async function loadCollection(): Promise<Album[]> {
  const json = await AsyncStorage.getItem(COLLECTION_KEY);
  if (!json) return [];
  const albums = JSON.parse(json) as Album[];
  if (!Array.isArray(albums)) throw new Error('Stored collection is not a list');
  // Migrate old RedStatus objects that lack the 'result' field
  for (const album of albums) {
    if (album.redStatus && !album.redStatus.result) {
      album.redStatus.result = album.redStatus.uploaded ? 'uploaded' : 'not_uploaded';
    }
  }
  return albums;
}

export async function saveCollection(albums: Album[]): Promise<void> {
  await AsyncStorage.setItem(COLLECTION_KEY, JSON.stringify(albums));
}

export async function loadLists(): Promise<StoredLists> {
  const json = await AsyncStorage.getItem(LISTS_KEY);
  let stored: Partial<StoredLists> | null = null;
  try {
    stored = json ? JSON.parse(json) : null;
  } catch (e) {
    console.warn('Stored lists are unreadable', e);
  }
  // Unreadable lists fall back to Collection only
  const lists = (Array.isArray(stored?.lists) ? stored.lists : []).filter(
    (l) => typeof l?.id === 'string' && typeof l.name === 'string' && l.id !== DEFAULT_LIST_ID,
  );
  const lastListId = lists.find((l) => l.id === stored?.lastListId)?.id ?? DEFAULT_LIST_ID;
  return { lists, lastListId };
}

export async function saveLists(stored: StoredLists): Promise<void> {
  await AsyncStorage.setItem(LISTS_KEY, JSON.stringify(stored));
}

export async function loadSettings(): Promise<Settings> {
  const json = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!json) return { discogsToken: '', themeMode: 'system', redApiKey: '', frogModeActive: false, frogModeFound: false};
  return JSON.parse(json) as Settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
