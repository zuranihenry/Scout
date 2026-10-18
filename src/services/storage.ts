import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { Album, Settings, StoredLists } from '../types';
import { DEFAULT_LIST_ID } from './lists';

const COLLECTION_KEY = 'scout_collection';
const SETTINGS_KEY = 'scout_settings';
const LISTS_KEY = 'scout_lists';

// API keys are kept in secure storage, not in the settings JSON
type SecretField = 'discogsToken' | 'redApiKey';
const SECRET_KEYS: Record<SecretField, string> = {
  discogsToken: 'scout_discogs_token',
  redApiKey: 'scout_red_api_key',
};
const SECRET_FIELDS = Object.keys(SECRET_KEYS) as SecretField[];

const DEFAULT_SETTINGS: Settings = {
  discogsToken: '',
  themeMode: 'system',
  redApiKey: '',
  frogModeActive: false,
  frogModeFound: false,
};

export async function loadCollection(): Promise<Album[]> {
  const json = await AsyncStorage.getItem(COLLECTION_KEY);
  if (!json) return [];
  const albums = JSON.parse(json) as Album[];
  if (!Array.isArray(albums)) throw new Error('Stored collection is not a list');
  // Migrate old redStatus objects that lack the 'result' field
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

async function readSecret(field: SecretField): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(SECRET_KEYS[field])) ?? '';
  } catch (e) {
    console.warn(`Could not read ${field} from secure storage`, e);
    return '';
  }
}

async function writeSecret(field: SecretField, value: string): Promise<boolean> {
  try {
    if (value) await SecureStore.setItemAsync(SECRET_KEYS[field], value);
    else await SecureStore.deleteItemAsync(SECRET_KEYS[field]);
    return true;
  } catch (e) {
    console.warn(`Could not save ${field} to secure storage`, e);
    return false;
  }
}

function withoutSecrets(settings: Partial<Settings>, fields = SECRET_FIELDS): Partial<Settings> {
  const rest = { ...settings };
  for (const field of fields) delete rest[field];
  return rest;
}

export async function loadSettings(): Promise<Settings> {
  const json = await AsyncStorage.getItem(SETTINGS_KEY);
  const stored: Partial<Settings> = json ? JSON.parse(json) : {};
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  // Older versions kept the keys here, drop them only once secure storage has them
  const legacy = SECRET_FIELDS.filter((field) => field in stored);
  const moved = await Promise.all(legacy.map((field) => writeSecret(field, settings[field])));
  if (legacy.length > 0 && moved.every(Boolean)) {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(withoutSecrets(stored)));
  }
  for (const field of SECRET_FIELDS) {
    if (!legacy.includes(field)) settings[field] = await readSecret(field);
  }
  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const saved = await Promise.all(SECRET_FIELDS.map((field) => writeSecret(field, settings[field])));
  // A key that secure storage refused stays in the JSON, so it isn't lost and moves on the next load
  const moved = SECRET_FIELDS.filter((_, i) => saved[i]);
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(withoutSecrets(settings, moved)));
}
