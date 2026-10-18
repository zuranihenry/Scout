import React, { useState, useMemo, useEffect, useRef, useCallback, useDeferredValue } from 'react';
import { View, Image, ScrollView, Pressable, Keyboard, StyleSheet } from 'react-native';
import { ActivityIndicator, Portal, Dialog, Button, Chip, Menu, Text, TextInput, Divider, useTheme, type MD3Theme } from 'react-native-paper';
import type { DiscogsSearchResult, DiscogsReleaseDetail } from '../types';
import { useSettings } from '../context/SettingsContext';
import { parseArtistTitle, stripDiscogsDisambiguator, fetchReleaseDetail, DiscogsError } from '../services/discogs';
import {
  sortByPopularity,
  mostCommonId,
  sharedDetails,
  differingDetails,
  formatNames,
  searchImage,
  matchesDiscQuery,
  type PressingDetailKey,
} from '../services/pressings';

interface ReleasePickerProps {
  visible: boolean;
  candidates: DiscogsSearchResult[];
  coverMap: Map<number, string>;
  loading?: boolean;
  error: string | null;
  errorRemovable: boolean;
  onErrorDismiss: () => void;
  onSelect: (result: DiscogsSearchResult, detail?: DiscogsReleaseDetail) => void;
  onDismiss: () => void;
}

/** Extract unique non-empty values from an array accessor on candidates. */
function uniqueValues(
  candidates: DiscogsSearchResult[],
  accessor: (c: DiscogsSearchResult) => string | string[] | undefined,
): string[] {
  const set = new Set<string>();
  for (const c of candidates) {
    for (const v of [accessor(c)].flat()) {
      if (v) set.add(v);
    }
  }
  return [...set].sort();
}

function uniqueLabels(candidates: DiscogsSearchResult[]): string[] {
  const set = new Set<string>();
  for (const c of candidates) {
    for (const l of c.label ?? []) {
      const stripped = stripDiscogsDisambiguator(l);
      if (stripped) set.add(stripped);
    }
  }
  return [...set].sort();
}

interface Filters {
  title: string | null;
  artist: string | null;
  format: string | null;
  year: string | null;
  label: string | null;
  country: string | null;
}

const emptyFilters: Filters = { title: null, artist: null, format: null, year: null, label: null, country: null };

const detailLabels: Record<PressingDetailKey, string> = {
  label: 'Label',
  catno: 'Cat#',
  format: 'Format',
  country: 'Country',
  year: 'Year',
};

export default function ReleasePicker({
  visible,
  candidates,
  coverMap,
  loading,
  error,
  errorRemovable,
  onErrorDismiss,
  onSelect,
  onDismiss,
}: ReleasePickerProps) {
  const theme = useTheme();
  const { settings } = useSettings();
  const token = settings.discogsToken || undefined;
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [query, setQuery] = useState('');
  const discQuery = useDeferredValue(query);
  // Release details fetched while the picker is open, kept for later sessions
  const detailsRef = useRef(new Map<number, DiscogsReleaseDetail | null>());
  const prefetchRef = useRef<Promise<void>>(Promise.resolve());
  const [detailsVersion, setDetailsVersion] = useState(0);
  const [prefetchState, setPrefetchState] = useState<'idle' | 'loading' | 'limited'>('idle');

  // Reset filters and search when the picker opens, so removing a candidate keeps them
  const [prevVisible, setPrevVisible] = useState(visible);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (visible) {
      setFilters(emptyFilters);
      setQuery('');
    }
  }

  const sorted = useMemo(() => sortByPopularity(candidates), [candidates]);
  const topId = useMemo(() => mostCommonId(candidates), [candidates]);

  // Apply a subset of filters (excluding one key) to get candidates for that key's dropdown
  const applyFilters = useMemo(() => {
    const parsed = new Map(sorted.map((c) => [c.id, parseArtistTitle(c.title)] as const));
    const matchesTitle = (c: DiscogsSearchResult) => !filters.title || parsed.get(c.id)?.title === filters.title;
    const matchesArtist = (c: DiscogsSearchResult) => !filters.artist || parsed.get(c.id)?.artist === filters.artist;
    const matchesFormat = (c: DiscogsSearchResult) => !filters.format || formatNames(c).includes(filters.format);
    const matchesYear = (c: DiscogsSearchResult) => !filters.year || c.year === filters.year;
    const matchesLabel = (c: DiscogsSearchResult) => !filters.label || (c.label ?? []).some(
      (l) => stripDiscogsDisambiguator(l) === filters.label,
    );
    const matchesCountry = (c: DiscogsSearchResult) => !filters.country || c.country === filters.country;

    const allDropdown = [matchesTitle, matchesArtist, matchesFormat, matchesYear, matchesLabel, matchesCountry];
    const without = (skip: number) => sorted.filter((c) => allDropdown.every((fn, i) => i === skip || fn(c)));

    return {
      all: sorted.filter((c) => allDropdown.every((fn) => fn(c))),
      exceptTitle: without(0),
      exceptArtist: without(1),
      exceptFormat: without(2),
      exceptYear: without(3),
      exceptLabel: without(4),
      exceptCountry: without(5),
    };
  }, [sorted, filters]);

  const filtered = applyFilters.all;
  const results = useMemo(
    () => filtered.filter((c) => matchesDiscQuery(c, detailsRef.current.get(c.id) ?? undefined, discQuery)),
    [filtered, discQuery, detailsVersion],
  );
  const shared = useMemo(() => sharedDetails(results), [results]);

  const loadDetail = useCallback(async (id: number) => {
    const detail = await fetchReleaseDetail(id, token);
    detailsRef.current.set(id, detail);
    setDetailsVersion((v) => v + 1);
  }, [token]);

  // Once the filters leave a few candidates, fetch their details so the disc
  // search can also match identifiers and notes. One request at a time to go
  // easy on Discogs' rate limit; editing the search retries after a 429.
  const detailLimit = token ? 20 : 10;
  const prefetchKey = query.trim() && filtered.length <= detailLimit
    ? filtered.map((c) => c.id).join(',')
    : '';

  useEffect(() => {
    const ids = prefetchKey.split(',').filter(Boolean).map(Number).filter((id) => !detailsRef.current.has(id));
    if (!visible || ids.length === 0) return;
    let cancelled = false;
    const previous = prefetchRef.current;
    setPrefetchState('loading');
    prefetchRef.current = (async () => {
      // Let a cancelled run finish its request first
      await previous;
      for (const id of ids) {
        if (cancelled) return;
        if (detailsRef.current.has(id)) continue;
        try {
          await loadDetail(id);
        } catch (err) {
          if (err instanceof DiscogsError && err.status === 429) {
            if (!cancelled) setPrefetchState('limited');
            return;
          }
        }
      }
      if (!cancelled) setPrefetchState('idle');
    })();
    return () => {
      cancelled = true;
      setPrefetchState('idle');
    };
  }, [visible, prefetchKey, query, loadDetail]);

  let searchHint = '';
  if (prefetchState === 'loading') searchHint = 'Searching pressing details...';
  else if (prefetchState === 'limited') searchHint = 'Discogs rate limit reached. Try again shortly.';
  else if (query.trim() && filtered.length > detailLimit) {
    searchHint = `Narrow to ${detailLimit} results or fewer to also search runouts and notes`;
  }

  const select = (candidate: DiscogsSearchResult) => {
    Keyboard.dismiss();
    onSelect(candidate, detailsRef.current.get(candidate.id) ?? undefined);
  };

  // Each dropdown shows values from candidates filtered by the OTHER active filters
  const titles = uniqueValues(applyFilters.exceptTitle, (c) => parseArtistTitle(c.title).title || undefined);
  const artists = uniqueValues(applyFilters.exceptArtist, (c) => parseArtistTitle(c.title).artist || undefined);
  const formats = uniqueValues(applyFilters.exceptFormat, formatNames);
  const years = uniqueValues(applyFilters.exceptYear, (c) => c.year || undefined);
  const labels = uniqueLabels(applyFilters.exceptLabel);
  const countries = uniqueValues(applyFilters.exceptCountry, (c) => c.country);

  const setFilter = (key: keyof Filters, value: string | null) => {
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const hasActiveFilters = filters.title || filters.artist || filters.format || filters.year || filters.label || filters.country;

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={loading ? undefined : onDismiss} style={styles.dialog} dismissable={!loading}>
        <Dialog.Title>Choose pressing</Dialog.Title>
        <View style={styles.searchSection}>
          <TextInput
            mode="outlined"
            label="What's on your disc?"
            placeholder="Matrix, catalog number or label"
            value={query}
            onChangeText={setQuery}
            dense
            autoCapitalize="none"
            autoCorrect={false}
            right={query ? <TextInput.Icon icon="close" onPress={() => setQuery('')} accessibilityLabel="Clear search" /> : undefined}
          />
          {searchHint ? (
            <Text variant="labelSmall" style={[styles.searchHint, { color: theme.colors.onSurfaceVariant }]}>
              {searchHint}
            </Text>
          ) : null}
        </View>
        <Dialog.ScrollArea style={styles.scrollArea}>
          {loading && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" />
            </View>
          )}
          <ScrollView
            pointerEvents={loading ? 'none' : 'auto'}
            style={loading ? { opacity: 0.4 } : undefined}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            {/* Filters */}
            <View style={styles.filterSection}>
              <FilterDropdown
                label="Format"
                values={formats}
                selected={filters.format}
                onSelect={(v) => setFilter('format', v)}
              />
              <FilterDropdown
                label="Year"
                values={years}
                selected={filters.year}
                onSelect={(v) => setFilter('year', v)}
              />
              <FilterDropdown
                label="Country"
                values={countries}
                selected={filters.country}
                onSelect={(v) => setFilter('country', v)}
              />
              <FilterDropdown
                label="Title"
                values={titles}
                selected={filters.title}
                onSelect={(v) => setFilter('title', v)}
              />
              <FilterDropdown
                label="Artist"
                values={artists}
                selected={filters.artist}
                onSelect={(v) => setFilter('artist', v)}
              />
              <FilterDropdown
                label="Label"
                values={labels}
                selected={filters.label}
                onSelect={(v) => setFilter('label', v)}
              />
            </View>
            <Divider />

            {/* Results */}
            {shared.length > 0 ? (
              <View style={[styles.sharedCard, { backgroundColor: theme.colors.surfaceVariant }]}>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  All {results.length} results: {shared.map((d) => d.value).join(' · ')}
                </Text>
              </View>
            ) : results.length > 0 ? (
              <Text variant="labelSmall" style={[styles.resultCount, { color: theme.colors.onSurfaceVariant }]}>
                {results.length} result{results.length !== 1 ? 's' : ''}
              </Text>
            ) : null}
            {results.map((candidate, index) => {
              const { artist, title } = parseArtistTitle(candidate.title);
              const cover = searchImage(candidate) || coverMap.get(candidate.id);
              const differing = differingDetails(candidate, shared);
              return (
                <React.Fragment key={candidate.id}>
                  {index > 0 && <Divider />}
                  <Pressable
                    onPress={() => select(candidate)}
                    style={({ pressed }) => [
                      styles.item,
                      pressed && { backgroundColor: theme.colors.surfaceVariant },
                    ]}
                  >
                    <View style={styles.itemRow}>
                      {cover ? (
                        <Image source={{ uri: cover }} style={styles.thumb} />
                      ) : (
                        <View style={[styles.thumb, { backgroundColor: theme.colors.surfaceVariant }]} />
                      )}
                      <View style={styles.itemContent}>
                        <Text variant="titleSmall" numberOfLines={1}>{title}</Text>
                        <Text variant="bodySmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
                          {artist}
                        </Text>
                        {candidate.id === topId && (
                          <View style={styles.badgeRow}>
                            <Chip icon="star" compact textStyle={styles.badgeText}>
                              Most common
                            </Chip>
                          </View>
                        )}
                        {differing.length > 0 && (
                          <View style={styles.detailBlock}>
                            {differing.map((d) => (
                              <InfoRow key={d.key} label={detailLabels[d.key]} value={d.value} theme={theme} />
                            ))}
                          </View>
                        )}
                      </View>
                    </View>
                  </Pressable>
                </React.Fragment>
              );
            })}

            {results.length === 0 && (
              <Text
                variant="bodyMedium"
                style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}
              >
                No releases match the current filters
              </Text>
            )}
          </ScrollView>
        </Dialog.ScrollArea>
        <Dialog.Actions>
          {hasActiveFilters ? (
            <Button onPress={() => setFilters(emptyFilters)}>Clear filters</Button>
          ) : null}
          <Button onPress={onDismiss} disabled={loading}>Cancel</Button>
        </Dialog.Actions>
      </Dialog>
      <Dialog visible={!!error} onDismiss={onErrorDismiss}>
        <Dialog.Title>Oh no!</Dialog.Title>
        <Dialog.Content>
          <Text variant="bodyMedium">{error}</Text>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onErrorDismiss}>{errorRemovable ? 'Remove from results' : 'OK'}</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

function InfoRow({ label, value, theme }: {
  label: string;
  value: string;
  theme: MD3Theme;
}) {
  return (
    <View style={styles.infoRow}>
      <Text variant="labelSmall" style={[styles.infoLabel, { color: theme.colors.onSurfaceVariant }]}>
        {label}
      </Text>
      <Text
        variant="bodySmall"
        style={[styles.infoValue, { color: theme.colors.onSurfaceVariant }]}
      >
        {value}
      </Text>
    </View>
  );
}

function FilterDropdown({
  label,
  values,
  selected,
  onSelect,
}: {
  label: string;
  values: string[];
  selected: string | null;
  onSelect: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  if (values.length === 0 && !selected) return null;

  return (
    <View>
      <Menu
        visible={open}
        onDismiss={() => setOpen(false)}
        anchor={
          <Pressable onPress={() => setOpen(true)}>
            <TextInput
              mode="outlined"
              label={label}
              value={selected ?? 'All'}
              dense
              editable={false}
              right={<TextInput.Icon icon="menu-down" onPress={() => setOpen(true)} />}
              pointerEvents="none"
            />
          </Pressable>
        }
      >
        <Menu.Item
          title="All"
          onPress={() => { onSelect(null); setOpen(false); }}
          titleStyle={!selected ? { fontWeight: '700' } : undefined}
        />
        {values.map((v) => (
          <Menu.Item
            key={v}
            title={v}
            onPress={() => { onSelect(v); setOpen(false); }}
            titleStyle={selected === v ? { fontWeight: '700' } : undefined}
          />
        ))}
      </Menu>
    </View>
  );
}

const styles = StyleSheet.create({
  dialog: {
    maxHeight: '80%',
  },
  searchSection: {
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  searchHint: {
    marginTop: 4,
  },
  scrollArea: {
    paddingHorizontal: 0,
    position: 'relative',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1,
  },
  filterSection: {
    paddingHorizontal: 24,
    paddingBottom: 12,
    gap: 8,
  },
  item: {
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 4,
    marginRight: 12,
  },
  itemContent: {
    flex: 1,
    minWidth: 0,
  },
  detailBlock: {
    marginTop: 4,
    gap: 2,
  },
  badgeRow: {
    flexDirection: 'row',
    marginTop: 4,
  },
  badgeText: {
    fontSize: 11,
  },
  resultCount: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 4,
  },
  sharedCard: {
    marginHorizontal: 24,
    marginTop: 8,
    marginBottom: 4,
    padding: 8,
    borderRadius: 8,
  },
  infoRow: {
    flexDirection: 'row',
  },
  infoLabel: {
    width: 56,
    flexShrink: 0,
  },
  infoValue: {
    flex: 1,
    flexShrink: 1,
  },
  emptyText: {
    textAlign: 'center',
    padding: 24,
  },
});
