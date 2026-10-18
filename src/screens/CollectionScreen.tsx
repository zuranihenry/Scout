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
import { getRedStatus, RedAuthError, RedForbiddenError, RedUnavailableError } from '../services/redacted';
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
  const [redSearchingIds, setRedSearchingIds] = useState<Set<string>>(new Set());
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

  const handleSelectNotOnRed = useCallback(() => {
    const ids = visibleAlbums.filter((a) => a.redStatus && !a.redStatus.uploaded).map((a) => a.id);
    if (!enterSelectionWithIds(ids)) {
      setSnackbar('No items are marked as not on RED');
    }
  }, [visibleAlbums, enterSelectionWithIds]);

  const handleSelectNoRedStatus = useCallback(() => {
    const ids = visibleAlbums.filter((a) => !a.redStatus).map((a) => a.id);
    if (!enterSelectionWithIds(ids)) {
      setSnackbar('All items have been checked on RED');
    }
  }, [visibleAlbums, enterSelectionWithIds]);

  const lookupRedStatuses = useCallback(async (albumsToCheck: Album[]) => {
    const apiKey = settings.redApiKey;
    const token = settings.discogsToken || undefined;
    if (!apiKey || albumsToCheck.length === 0) return { updated: 0, stopped: false };

    setRedSearchingIds(new Set(albumsToCheck.map((a) => a.id)));
    let updated = 0;
    let stopped = false;

    for (const album of albumsToCheck) {
      try {
        const detail = await fetchReleaseDetail(album.discogsId, token);
        if (!detail) continue;
        detail.barcode = album.barcode;
        if (!detail.artistDisplay || detail.artistDisplay === 'Unknown') {
          detail.artistDisplay = album.artist;
        }
        const status = await getRedStatus(detail, apiKey);
        updateAlbum(album.id, { redStatus: status });
        updated++;
      } catch (err) {
        if (err instanceof RedAuthError) {
          setRedSearchingIds(new Set());
          showRedError(err.title, err.message);
          stopped = true;
          break;
        }
        if (err instanceof RedForbiddenError) {
          setRedSearchingIds(new Set());
          showRedError(err.title, err.message);
          stopped = true;
          break;
        }
        if (err instanceof RedUnavailableError) {
          setRedSearchingIds(new Set());
          setSnackbar(err.message);
          stopped = true;
          break;
        }
        // Continue with remaining items on other failures
      } finally {
        setRedSearchingIds((prev) => {
          const next = new Set(prev);
          next.delete(album.id);
          return next;
        });
      }
    }

    return { updated, stopped };
  }, [settings.redApiKey, settings.discogsToken, showRedError, updateAlbum]);

  const handleLookupRed = useCallback(async () => {
    if (refreshing) return;

    const selected = visibleAlbums.filter((a) => selectedIds.has(a.id));
    if (selected.length === 0) return;

    setRedLookupLoading(true);
    try {
      const { updated, stopped } = await lookupRedStatuses(selected);
      if (!stopped) {
        setSnackbar(`Updated RED status for ${updated} item${updated !== 1 ? 's' : ''}`);
      }
    } finally {
      setRedLookupLoading(false);
    }
  }, [visibleAlbums, selectedIds, refreshing, lookupRedStatuses]);

  const handleRefresh = useCallback(async () => {
    if (selectionMode || redLookupLoading || refreshing) return;
    if (!settings.redApiKey) {
      setSnackbar('Add a RED API key in Settings to refresh RED statuses');
      return;
    }

    setRefreshing(true);
    refreshingRef.current = true;
    try {
      const { updated, stopped } = await lookupRedStatuses(visibleAlbums);
      if (!stopped) {
        setSnackbar(`Refreshed RED status for ${updated} item${updated !== 1 ? 's' : ''}`);
      }
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [visibleAlbums, selectionMode, redLookupLoading, refreshing, settings.redApiKey, lookupRedStatuses]);

  // AlbumCard's memo can keep an old onChoosePressing, so it reads these from refs
  const discogsTokenRef = useRef(settings.discogsToken);
  discogsTokenRef.current = settings.discogsToken;
  const redBusyRef = useRef(false);
  redBusyRef.current = refreshing || redLookupLoading;

  const handleChoosePressing = useCallback(async (album: Album) => {
    if (choosingPressingRef.current) return;
    // A RED check that is still running would save a status for the old pressing
    if (redBusyRef.current) {
      setSnackbar('Wait for the RED check to finish');
      return;
    }
    choosingPressingRef.current = true;
    setPressingLoadingId(album.id);
    try {
      const results = await searchByBarcode(album.barcode, discogsTokenRef.current || undefined);
      // A RED check may have started while searching
      if (redBusyRef.current) {
        setSnackbar('Wait for the RED check to finish');
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
    const changes = { ...albumFromRelease(selected, detail), pressingConfirmed: undefined, redStatus: undefined };
    updateAlbum(album.id, changes);
    setPressingAlbum(null);
    setSnackbar('Pressing updated');
    // The RED status was for the old pressing, so check the new one
    setRedLookupLoading(true);
    try {
      await lookupRedStatuses([{ ...album, ...changes }]);
    } finally {
      setRedLookupLoading(false);
    }
  }, [pressingAlbum, settings.discogsToken, updateAlbum, lookupRedStatuses]);

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
        redSearching={redSearchingIds.has(item.id)}
        pressingLoading={pressingLoadingId === item.id}
        onPress={() => (selectionMode ? toggleSelect(item.id) : undefined)}
        onLongPress={() => !selectionMode && enterSelectionMode(item.id)}
        onToggleExpand={() => toggleExpand(item.id)}
        onChoosePressing={handleChoosePressing}
      />
    ),
    [selectionMode, selectedIds, expandedIds, toggleSelect, toggleExpand, enterSelectionMode, settings.frogModeActive, redSearchingIds, pressingLoadingId, handleChoosePressing],
  );

  const keyExtractor = useCallback((item: Album) => item.id, []);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View>
        <Appbar.Header statusBarHeight={0} style={{ backgroundColor: theme.colors.elevation.level2 }}>
          <Appbar.Content title={activeList.name} />
          <CollectionMenu
            onSelectAll={handleSelectAll}
            onSelectNotOnRed={handleSelectNotOnRed}
            onSelectNoRedStatus={handleSelectNoRedStatus}
            hasRedApiKey={!!settings.redApiKey}
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
              onLookupRed={handleLookupRed}
              redLookupLoading={redLookupLoading || refreshing}
              hasRedApiKey={!!settings.redApiKey}
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
