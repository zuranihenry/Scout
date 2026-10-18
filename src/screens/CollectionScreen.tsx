import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { StyleSheet, BackHandler, View, Alert, RefreshControl, ScrollView } from 'react-native';
import { Appbar, Chip, Snackbar, useTheme } from 'react-native-paper';
import Animated, { useAnimatedRef } from 'react-native-reanimated';
import Sortable from 'react-native-sortables';
import type { SortableGridRenderItem } from 'react-native-sortables';
import * as Haptics from 'expo-haptics';
import { useCollection } from '../context/CollectionContext';
import { useSettings } from '../context/SettingsContext';
import { useRedError } from '../context/RedErrorContext';
import {
  getTrackerStatus,
  apiKeyFor,
  configuredTrackers,
  trackerNames,
  trackerStatus,
  STATUS_FIELD,
  TRACKERS,
  TrackerAuthError,
  TrackerForbiddenError,
  TrackerUnavailableError,
  type TrackerId,
} from '../services/gazelle';
import { fetchReleaseDetail, searchByBarcode, discogsErrorMessage } from '../services/discogs';
import { albumFromRelease } from '../services/album';
import { DEFAULT_LIST_ID, albumListId, countByList, findList } from '../services/lists';
import AlbumCard from '../components/AlbumCard';
import SelectionToolbar from '../components/SelectionToolbar';
import CollectionMenu from '../components/CollectionMenu';
import EmptyCollection from '../components/EmptyCollection';
import ReleasePicker from '../components/ReleasePicker';
import ListNameDialog from '../components/ListNameDialog';
import ListPickerDialog from '../components/ListPickerDialog';
import type { Album, AlbumList, DiscogsSearchResult, DiscogsReleaseDetail } from '../types';

export default function CollectionScreen() {
  const { albums, lists, loadError, removeAlbums, reorder, updateAlbum, moveAlbums, createList, renameList, deleteList } = useCollection();
  const { settings } = useSettings();
  const [activeListId, setActiveListId] = useState(DEFAULT_LIST_ID);
  const [nameDialog, setNameDialog] = useState<{ visible: boolean; list?: AlbumList }>({ visible: false });
  const [moveDialogVisible, setMoveDialogVisible] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [snackbar, setSnackbar] = useState('');
  const [redLookupLoading, setRedLookupLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());
  const [checkingTrackers, setCheckingTrackers] = useState<TrackerId[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [pressingAlbum, setPressingAlbum] = useState<Album | null>(null);
  const [pressingCandidates, setPressingCandidates] = useState<DiscogsSearchResult[]>([]);
  const [pressingLoadingId, setPressingLoadingId] = useState<string | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<{ id: number; message: string; removable: boolean } | null>(null);
  const choosingPressingRef = useRef(false);
  const { showRedError } = useRedError();
  const theme = useTheme();

  const activeList = findList(lists, activeListId);
  const visibleAlbums = useMemo(
    () => albums.filter((a) => albumListId(a) === activeList.id),
    [albums, activeList.id],
  );
  const listCounts = useMemo(() => countByList(albums), [albums]);
  const trackers = useMemo(() => configuredTrackers(settings), [settings]);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  useEffect(() => {
    if (!selectionMode) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      exitSelectionMode();
      return true;
    });
    return () => sub.remove();
  }, [selectionMode, exitSelectionMode]);

  useEffect(() => {
    if (selectionMode) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (expandedIds.size > 0) {
        setExpandedIds(new Set());
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [selectionMode, expandedIds]);

  const enterSelectionWithIds = useCallback((ids: string[]) => {
    if (ids.length === 0) return false;
    setSelectionMode(true);
    setSelectedIds(new Set(ids));
    return true;
  }, []);

  // AlbumCard's memo can keep an old onLongPress, so read refreshing from a ref
  const enterSelectionMode = useCallback((id: string) => {
    if (refreshingRef.current) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    enterSelectionWithIds([id]);
  }, [enterSelectionWithIds]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        if (next.size === 0) {
          setSelectionMode(false);
          return new Set();
        }
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleDelete = useCallback(() => {
    const count = selectedIds.size;
    Alert.alert(
      `Delete ${count} item${count > 1 ? 's' : ''}?`,
      'This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            removeAlbums(Array.from(selectedIds));
            exitSelectionMode();
            setSnackbar(`Deleted ${count} item${count > 1 ? 's' : ''}`);
          },
        },
      ],
    );
  }, [selectedIds, removeAlbums, exitSelectionMode]);

  const handleMove = useCallback((list: AlbumList) => {
    const count = selectedIds.size;
    moveAlbums(Array.from(selectedIds), list.id);
    setMoveDialogVisible(false);
    exitSelectionMode();
    setSnackbar(`Moved ${count} item${count > 1 ? 's' : ''} to ${list.name}`);
  }, [selectedIds, moveAlbums, exitSelectionMode]);

  const handleSelectAll = useCallback(() => {
    enterSelectionWithIds(visibleAlbums.map((a) => a.id));
  }, [visibleAlbums, enterSelectionWithIds]);

  const handleSelectNotOnTracker = useCallback((tracker: TrackerId) => {
    const ids = visibleAlbums.filter((a) => trackerStatus(a, tracker)?.uploaded === false).map((a) => a.id);
    if (!enterSelectionWithIds(ids)) {
      setSnackbar(`No items are marked as not on ${TRACKERS[tracker].name}`);
    }
  }, [visibleAlbums, enterSelectionWithIds]);

  const handleSelectNoTrackerStatus = useCallback((tracker: TrackerId) => {
    const ids = visibleAlbums.filter((a) => !trackerStatus(a, tracker)).map((a) => a.id);
    if (!enterSelectionWithIds(ids)) {
      setSnackbar(`All items have been checked on ${TRACKERS[tracker].name}`);
    }
  }, [visibleAlbums, enterSelectionWithIds]);

  // Fetches each release from Discogs once, then checks it on every tracker with a key.
  // A tracker that fails stops being checked, while the others carry on.
  const lookupTrackerStatuses = useCallback(async (albumsToCheck: Album[]) => {
    const token = settings.discogsToken || undefined;
    let active = configuredTrackers(settings);
    if (active.length === 0 || albumsToCheck.length === 0) return { updated: 0, stopped: false };

    setCheckingIds(new Set(albumsToCheck.map((a) => a.id)));
    setCheckingTrackers(active);
    let updated = 0;
    let stopped = false;

    const stopTracker = (tracker: TrackerId) => {
      active = active.filter((t) => t !== tracker);
      setCheckingTrackers(active);
      stopped = true;
    };

    for (const album of albumsToCheck) {
      if (active.length === 0) break;
      try {
        const detail = await fetchReleaseDetail(album.discogsId, token);
        if (!detail) continue;
        detail.barcode = album.barcode;
        if (!detail.artistDisplay || detail.artistDisplay === 'Unknown') {
          detail.artistDisplay = album.artist;
        }
        const results = await Promise.all(active.map(async (tracker) => {
          try {
            const status = await getTrackerStatus(tracker, detail, apiKeyFor(settings, tracker));
            updateAlbum(album.id, { [STATUS_FIELD[tracker]]: status });
            return true;
          } catch (err) {
            if (err instanceof TrackerAuthError || err instanceof TrackerForbiddenError) {
              stopTracker(tracker);
              showRedError(err.title, err.message);
            } else if (err instanceof TrackerUnavailableError) {
              stopTracker(tracker);
              setSnackbar(err.message);
            }
            return false;
          }
        }));
        if (results.some(Boolean)) updated++;
      } catch {
        // Continue with remaining items on other failures
      } finally {
        setCheckingIds((prev) => {
          const next = new Set(prev);
          next.delete(album.id);
          return next;
        });
      }
    }

    setCheckingIds(new Set());
    return { updated, stopped };
  }, [settings, showRedError, updateAlbum]);

  const handleLookup = useCallback(async () => {
    if (refreshing) return;

    const selected = visibleAlbums.filter((a) => selectedIds.has(a.id));
    if (selected.length === 0) return;

    setRedLookupLoading(true);
    try {
      const { updated, stopped } = await lookupTrackerStatuses(selected);
      if (!stopped) {
        setSnackbar(`Updated ${trackerNames(trackers)} status for ${updated} item${updated !== 1 ? 's' : ''}`);
      }
    } finally {
      setRedLookupLoading(false);
    }
  }, [visibleAlbums, selectedIds, refreshing, trackers, lookupTrackerStatuses]);

  const handleRefresh = useCallback(async () => {
    if (selectionMode || redLookupLoading || refreshing) return;
    if (trackers.length === 0) {
      setSnackbar('Add a RED or OPS API key in Settings to refresh statuses');
      return;
    }

    setRefreshing(true);
    refreshingRef.current = true;
    try {
      const { updated, stopped } = await lookupTrackerStatuses(visibleAlbums);
      if (!stopped) {
        setSnackbar(`Refreshed ${trackerNames(trackers)} status for ${updated} item${updated !== 1 ? 's' : ''}`);
      }
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [visibleAlbums, selectionMode, redLookupLoading, refreshing, trackers, lookupTrackerStatuses]);

  // AlbumCard's memo can keep an old onChoosePressing, so it reads these from refs
  const discogsTokenRef = useRef(settings.discogsToken);
  discogsTokenRef.current = settings.discogsToken;
  const redBusyRef = useRef(false);
  redBusyRef.current = refreshing || redLookupLoading;

  const handleChoosePressing = useCallback(async (album: Album) => {
    if (choosingPressingRef.current) return;
    // A tracker check that is still running would save a status for the old pressing
    if (redBusyRef.current) {
      setSnackbar('Wait for the tracker check to finish');
      return;
    }
    choosingPressingRef.current = true;
    setPressingLoadingId(album.id);
    try {
      const results = await searchByBarcode(album.barcode, discogsTokenRef.current || undefined);
      // A tracker check may have started while searching
      if (redBusyRef.current) {
        setSnackbar('Wait for the tracker check to finish');
        return;
      }
      const releases = results.filter((r) => r.type === 'release');
      if (releases.length === 0) {
        setSnackbar('No results found for this barcode');
        return;
      }
      setPressingCandidates(releases);
      setPressingAlbum(album);
    } catch (err) {
      setSnackbar(discogsErrorMessage(err, 'Failed to look up barcode. Check your connection.'));
    } finally {
      choosingPressingRef.current = false;
      setPressingLoadingId(null);
    }
  }, []);

  const handleSelectPressing = useCallback(async (selected: DiscogsSearchResult, cached?: DiscogsReleaseDetail) => {
    const album = pressingAlbum;
    if (!album) return;
    if (selected.id === album.discogsId) {
      updateAlbum(album.id, { pressingConfirmed: undefined });
      setPressingAlbum(null);
      setSnackbar('Pressing confirmed');
      return;
    }
    let detail: DiscogsReleaseDetail | null;
    setPickerLoading(true);
    try {
      detail = cached ?? await fetchReleaseDetail(selected.id, settings.discogsToken || undefined);
    } catch (err) {
      setPickerError({ id: selected.id, message: discogsErrorMessage(err, 'Failed to fetch release details. This may be a network issue.'), removable: false });
      return;
    } finally {
      setPickerLoading(false);
    }
    if (!detail) {
      setPickerError({ id: selected.id, message: 'Release details are unavailable on Discogs for this pressing. This is usually due to an issue with Discogs. Please select another pressing.', removable: true });
      return;
    }
    const changes = { ...albumFromRelease(selected, detail), pressingConfirmed: undefined, redStatus: undefined, opsStatus: undefined };
    updateAlbum(album.id, changes);
    setPressingAlbum(null);
    setSnackbar('Pressing updated');
    // The tracker statuses were for the old pressing, so check the new one
    setRedLookupLoading(true);
    try {
      await lookupTrackerStatuses([{ ...album, ...changes }]);
    } finally {
      setRedLookupLoading(false);
    }
  }, [pressingAlbum, settings.discogsToken, updateAlbum, lookupTrackerStatuses]);

  const handlePickerErrorDismiss = useCallback(() => {
    if (pickerError?.removable) {
      setPressingCandidates((prev) => prev.filter((c) => c.id !== pickerError.id));
    }
    setPickerError(null);
  }, [pickerError]);

  const handleSelectList = useCallback((id: string) => {
    exitSelectionMode();
    setExpandedIds(new Set());
    setActiveListId(id);
  }, [exitSelectionMode]);

  const confirmDeleteList = useCallback((list: AlbumList) => {
    const count = listCounts.get(list.id) ?? 0;
    Alert.alert(
      `Delete "${list.name}"?`,
      count > 0 ? `Its ${count} release${count !== 1 ? 's' : ''} will be moved to Collection.` : undefined,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteList(list.id);
            if (list.id === activeList.id) handleSelectList(DEFAULT_LIST_ID);
          },
        },
      ],
    );
  }, [listCounts, deleteList, activeList.id, handleSelectList]);

  const handleListLongPress = useCallback((list: AlbumList) => {
    Alert.alert(list.name, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => confirmDeleteList(list) },
      { text: 'Rename', onPress: () => setNameDialog({ visible: true, list }) },
    ]);
  }, [confirmDeleteList]);

  const handleListNameSubmit = useCallback((name: string) => {
    if (nameDialog.list) {
      renameList(nameDialog.list.id, name);
    } else {
      handleSelectList(createList(name).id);
    }
    setNameDialog((prev) => ({ ...prev, visible: false }));
  }, [nameDialog.list, renameList, createList, handleSelectList]);

  const scrollRef = useAnimatedRef<Animated.ScrollView>();

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const renderItem = useCallback<SortableGridRenderItem<Album>>(
    ({ item }) => (
      <AlbumCard
        album={item}
        expanded={expandedIds.has(item.id)}
        isSelected={selectedIds.has(item.id)}
        selectionMode={selectionMode}
        frogModeActive={settings.frogModeActive}
        hasRedApiKey={!!settings.redApiKey}
        checkingTrackers={checkingIds.has(item.id) ? checkingTrackers : undefined}
        pressingLoading={pressingLoadingId === item.id}
        onPress={() => (selectionMode ? toggleSelect(item.id) : undefined)}
        onLongPress={() => !selectionMode && enterSelectionMode(item.id)}
        onToggleExpand={() => toggleExpand(item.id)}
        onChoosePressing={handleChoosePressing}
      />
    ),
    [selectionMode, selectedIds, expandedIds, toggleSelect, toggleExpand, enterSelectionMode, settings.frogModeActive, settings.redApiKey, checkingIds, checkingTrackers, pressingLoadingId, handleChoosePressing],
  );

  const keyExtractor = useCallback((item: Album) => item.id, []);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View>
        <Appbar.Header statusBarHeight={0} style={{ backgroundColor: theme.colors.elevation.level2 }}>
          <Appbar.Content title={activeList.name} />
          <CollectionMenu
            onSelectAll={handleSelectAll}
            onSelectNotOnTracker={handleSelectNotOnTracker}
            onSelectNoTrackerStatus={handleSelectNoTrackerStatus}
            trackers={trackers}
            disabled={loadError || visibleAlbums.length === 0 || refreshing}
          />
        </Appbar.Header>
        {selectionMode && (
          <View style={StyleSheet.absoluteFill}>
            <SelectionToolbar
              count={selectedIds.size}
              onDelete={handleDelete}
              onCancel={exitSelectionMode}
              onMove={() => setMoveDialogVisible(true)}
              onLookup={handleLookup}
              lookupLoading={redLookupLoading || refreshing}
              trackerNames={trackerNames(trackers)}
            />
          </View>
        )}
      </View>
      {!loadError && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.listBar}
          contentContainerStyle={styles.listChips}
        >
          {lists.map((list) => (
            <Chip
              key={list.id}
              mode={list.id === activeList.id ? 'flat' : 'outlined'}
              selected={list.id === activeList.id}
              onPress={() => handleSelectList(list.id)}
              onLongPress={list.id === DEFAULT_LIST_ID ? undefined : () => handleListLongPress(list)}
              disabled={selectionMode || refreshing}
            >
              {`${list.name} ${listCounts.get(list.id) ?? 0}`}
            </Chip>
          ))}
          <Chip
            icon="plus"
            mode="outlined"
            onPress={() => setNameDialog({ visible: true })}
            disabled={selectionMode || refreshing}
          >
            New list
          </Chip>
        </ScrollView>
      )}
      {loadError || visibleAlbums.length === 0 ? (
        <EmptyCollection
          loadError={loadError}
          listName={activeList.id !== DEFAULT_LIST_ID || albums.length > 0 ? activeList.name : undefined}
        />
      ) : (
        <Animated.ScrollView
          key={activeList.id}
          ref={scrollRef}
          style={{ backgroundColor: theme.colors.background }}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              enabled={!selectionMode && !redLookupLoading}
              tintColor={theme.colors.primary}
              colors={[theme.colors.primary]}
            />
          }
        >
          <Sortable.Grid
            data={visibleAlbums}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            columns={1}
            scrollableRef={scrollRef}
            customHandle
            dragActivationDelay={0}
            sortEnabled={!selectionMode && !refreshing}
            activeItemScale={1}
            activeItemOpacity={0.9}
            activeItemShadowOpacity={0.3}
            inactiveItemOpacity={1}
            onDragStart={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
            onDragEnd={({ fromIndex, toIndex }) => {
              if (fromIndex !== toIndex) reorder(activeList.id, fromIndex, toIndex);
            }}
          />
        </Animated.ScrollView>
      )}
      <ReleasePicker
        visible={!!pressingAlbum}
        candidates={pressingCandidates}
        currentId={pressingAlbum?.discogsId}
        loading={pickerLoading}
        error={pickerError?.message ?? null}
        errorRemovable={!!pickerError?.removable}
        onSelect={handleSelectPressing}
        onDismiss={() => setPressingAlbum(null)}
        onErrorDismiss={handlePickerErrorDismiss}
      />
      <ListNameDialog
        visible={nameDialog.visible}
        list={nameDialog.list}
        onSubmit={handleListNameSubmit}
        onDismiss={() => setNameDialog((prev) => ({ ...prev, visible: false }))}
      />
      <ListPickerDialog
        visible={moveDialogVisible}
        title="Move to list"
        currentListId={activeList.id}
        onSelect={handleMove}
        onDismiss={() => setMoveDialogVisible(false)}
      />
      <Snackbar visible={!!snackbar} onDismiss={() => setSnackbar('')} duration={2000}>
        {snackbar}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  list: {
    paddingVertical: 8,
  },
  listBar: {
    flexGrow: 0,
  },
  listChips: {
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
});
