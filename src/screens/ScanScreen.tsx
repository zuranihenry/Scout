import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { View, StyleSheet, Image, Linking, AppState } from 'react-native';
import { Text, Button, Chip, Surface, Snackbar, ActivityIndicator, Icon, useTheme } from 'react-native-paper';
import { FontAwesome6 } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as Crypto from 'expo-crypto';
import { useCollection } from '../context/CollectionContext';
import { useSettings } from '../context/SettingsContext';
import { useRedError } from '../context/RedErrorContext';
import { searchByBarcode, fetchReleaseDetail, fetchReleaseImages, DiscogsError } from '../services/discogs';
import { getRedStatus, RedAuthError, RedForbiddenError } from '../services/redacted';
import { searchImage } from '../services/pressings';
import { albumFromRelease } from '../services/album';
import ReleasePicker from '../components/ReleasePicker';
import type { Album, DiscogsSearchResult, DiscogsReleaseDetail, RedStatus } from '../types';

type ScanState = 'idle' | 'looking_up' | 'disambiguate' | 'result' | 'error';

const SCAN_COOLDOWN = 3000;
const DUPLICATE_MESSAGE = 'This edition is already in your collection';

function discogsErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof DiscogsError)) return fallback;
  if (err.status === 401) return 'Discogs rejected the request. Check your Discogs token in Settings.';
  if (err.status === 429) return 'Discogs rate limit reached. Try again shortly.';
  return fallback;
}

export default function ScanScreen({ isActive }: { isActive: boolean }) {
  const theme = useTheme();
  const { addAlbum, updateAlbum, hasBarcode } = useCollection();
  const { settings, setFrogMode } = useSettings();
  const { showRedError } = useRedError();
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [result, setResult] = useState<DiscogsSearchResult | null>(null);
  const [lastAdded, setLastAdded] = useState<Album | null>(null);
  const [snackbar, setSnackbar] = useState('');
  const [duplicateBarcode, setDuplicateBarcode] = useState<string | null>(null);
  const scanLockRef = useRef(false);
  const scannedBarcodeRef = useRef('');
  const cooldownRef = useRef({ barcode: '', until: 0 });
  const [redStatus, setRedStatus] = useState<RedStatus | null>(null);
  const [redLoading, setRedLoading] = useState(false);
  const [redFailed, setRedFailed] = useState(false);
  const redLookupRef = useRef<{ releaseId: number; promise: Promise<RedStatus> } | null>(null);
  const [releaseDetail, setReleaseDetail] = useState<DiscogsReleaseDetail | null>(null);
  const [pressingConfirmed, setPressingConfirmed] = useState(true);
  const [candidates, setCandidates] = useState<DiscogsSearchResult[]>([]);
  const [coverMap, setCoverMap] = useState<Map<number, string>>(new Map());

  // Pick up a permission granted in the system settings
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') getPermission();
    });
    return () => sub.remove();
  }, [getPermission]);

  // Read through a ref so saving a key doesn't start a lookup for the open result
  const redApiKeyRef = useRef(settings.redApiKey);
  redApiKeyRef.current = settings.redApiKey;

  // Fetch RED status when release detail is available
  useEffect(() => {
    const apiKey = redApiKeyRef.current;
    if (!releaseDetail || !apiKey) {
      redLookupRef.current = null;
      setRedStatus(null);
      setRedFailed(false);
      setRedLoading(false);
      return;
    }
    let cancelled = false;
    setRedLoading(true);
    setRedFailed(false);
    const lookup = getRedStatus(releaseDetail, apiKey);
    redLookupRef.current = { releaseId: releaseDetail.id, promise: lookup };
    lookup
      .then((status) => { if (!cancelled) setRedStatus(status); })
      .catch((err) => {
        if (!cancelled) {
          setRedStatus(null);
          setRedFailed(true);
          if (err instanceof RedAuthError || err instanceof RedForbiddenError) showRedError(err.title, err.message);
        }
      })
      .finally(() => { if (!cancelled) setRedLoading(false); });
    return () => { cancelled = true; };
  }, [releaseDetail]);

  // Unlock scanning, ignoring the last barcode until it has left the frame
  const releaseScan = useCallback(() => {
    cooldownRef.current = { barcode: scannedBarcodeRef.current, until: Date.now() + SCAN_COOLDOWN };
    scanLockRef.current = false;
    setScanState('idle');
  }, []);

  const lookupBarcode = useCallback(
    async (data: string, { skipDuplicateCheck = false } = {}) => {
      if (scanLockRef.current) return;
      scanLockRef.current = true;
      scannedBarcodeRef.current = data;
      setSnackbar((prev) => (prev === DUPLICATE_MESSAGE ? '' : prev));
      setDuplicateBarcode(null);

      if (data === '682110000004') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setFrogMode(true);
        setSnackbar('Ribbit! Frog mode activated!');
        releaseScan();
        return;
      }

      setScanState('looking_up');

      try {
        if (!skipDuplicateCheck && hasBarcode(data)) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          setSnackbar(DUPLICATE_MESSAGE);
          setDuplicateBarcode(data);
          releaseScan();
          return;
        }

        const token = settings.discogsToken || undefined;
        const results = await searchByBarcode(data, token);
        const releases = results.filter((r) => r.type === 'release');

        if (releases.length === 0) {
          setScanState('error');
          setSnackbar('No results found for this barcode');
          setTimeout(releaseScan, 2000);
          return;
        }

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        if (releases.length === 1) {
          // Single result: fetch detail and auto-select
          const hit = releases[0]!;
          const detail = await fetchReleaseDetail(hit.id, token);
          if (!detail) {
            setScanState('error');
            setSnackbar('Release details unavailable');
            setTimeout(releaseScan, 2000);
            return;
          }
          detail.barcode = data;
          setResult(hit);
          setReleaseDetail(detail);
          setPressingConfirmed(true);
          setScanState('result');
        } else {
          // Multiple results: show picker (no detail fetching needed)
          setCandidates(releases);
          setCoverMap(new Map());
          setScanState('disambiguate');
          // Fetch one cover per unique title in background, for titles the search has no image for
          const titlesWithImage = new Set(releases.filter((r) => searchImage(r)).map((r) => r.title));
          const titleToFirst = new Map<string, number>();
          for (const r of releases) {
            if (!titlesWithImage.has(r.title) && !titleToFirst.has(r.title)) titleToFirst.set(r.title, r.id);
          }
          for (const [releaseTitle, releaseId] of titleToFirst) {
            fetchReleaseImages(releaseId, token)
              .then(({ coverImage }) => {
                if (!coverImage) return;
                const ids = releases.filter((r) => r.title === releaseTitle).map((r) => r.id);
                setCoverMap((prev) => {
                  const next = new Map(prev);
                  for (const id of ids) next.set(id, coverImage);
                  return next;
                });
              })
              .catch(() => {});
          }
        }
      } catch (err) {
        setScanState('error');
        setSnackbar(discogsErrorMessage(err, 'Failed to look up barcode. Check your connection.'));
        setTimeout(releaseScan, 2000);
      }
    },
    [hasBarcode, settings.discogsToken, releaseScan],
  );

  const handleBarcodeScanned = useCallback(
    ({ data }: BarcodeScanningResult) => {
      const cooldown = cooldownRef.current;
      if (data === cooldown.barcode && Date.now() < cooldown.until) {
        cooldown.until = Date.now() + SCAN_COOLDOWN;
        return;
      }
      lookupBarcode(data);
    },
    [lookupBarcode],
  );

  // The release as it will be saved
  const preview = useMemo(
    () => (result ? albumFromRelease(result, releaseDetail) : null),
    [result, releaseDetail],
  );

  const handleAdd = useCallback(() => {
    if (!preview) return;
    const album: Album = {
      ...preview,
      id: Crypto.randomUUID(),
      barcode: scannedBarcodeRef.current,
      addedAt: Date.now(),
      redStatus: redStatus ?? undefined,
    };
    if (!pressingConfirmed) album.pressingConfirmed = false;
    addAlbum(album);
    // Still checking RED, so save the result to the album once it arrives
    const lookup = redLookupRef.current;
    if (!redStatus && lookup && lookup.releaseId === releaseDetail?.id) {
      lookup.promise
        .then((status) => updateAlbum(album.id, { redStatus: status }))
        .catch(() => {});
    }
    setLastAdded(album);
    setResult(null);
    setReleaseDetail(null);
    releaseScan();
    setSnackbar(`Added "${album.title}" to collection`);
  }, [preview, releaseDetail, pressingConfirmed, redStatus, addAlbum, updateAlbum, releaseScan]);

  const handleDismiss = useCallback(() => {
    setResult(null);
    setReleaseDetail(null);
    setCandidates([]);
    releaseScan();
  }, [releaseScan]);

  const selectingRef = useRef(false);

  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<{ id: number; message: string; removable: boolean } | null>(null);

  const handleSelectRelease = useCallback(async (
    selected: DiscogsSearchResult,
    cached?: DiscogsReleaseDetail,
    confirmed = true,
  ) => {
    selectingRef.current = true;
    setPickerLoading(true);
    try {
      const token = settings.discogsToken || undefined;
      const fetched = cached ?? await fetchReleaseDetail(selected.id, token);
      if (!fetched) {
        setPickerError({ id: selected.id, message: 'Release details are unavailable on Discogs for this pressing. This is usually due to an issue with Discogs. Please select another pressing.', removable: true });
        return;
      }
      // The picker keeps its copy, so set the barcode on a new object
      const detail = { ...fetched, barcode: scannedBarcodeRef.current };
      setResult(selected);
      setReleaseDetail(detail);
      setPressingConfirmed(confirmed);
      setCandidates([]);
      setScanState('result');
    } catch (err) {
      setPickerError({ id: selected.id, message: discogsErrorMessage(err, 'Failed to fetch release details. This may be a network issue.'), removable: false });
    } finally {
      selectingRef.current = false;
      setPickerLoading(false);
    }
  }, [settings.discogsToken]);

  // "Not sure" in the picker passes its top match, which is saved as unconfirmed
  const handleUnsure = useCallback((selected: DiscogsSearchResult, cached?: DiscogsReleaseDetail) => {
    handleSelectRelease(selected, cached, false);
  }, [handleSelectRelease]);

  const handlePickerErrorDismiss = useCallback(() => {
    if (pickerError?.removable) {
      setCandidates((prev) => prev.filter((c) => c.id !== pickerError.id));
    }
    setPickerError(null);
  }, [pickerError]);

  const handlePickerDismiss = useCallback(() => {
    if (selectingRef.current) return;
    setCandidates([]);
    releaseScan();
  }, [releaseScan]);

  if (!permission) {
    return (
      <View style={[styles.container, styles.center, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.container, styles.center, { backgroundColor: theme.colors.background }]}>
        <Icon source="camera-off" size={48} color={theme.colors.onSurfaceVariant} />
        <Text variant="bodyLarge" style={styles.permText}>
          Camera access is needed to scan barcodes
        </Text>
        <Button
          mode="contained"
          onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()}
          style={styles.permButton}
        >
          {permission.canAskAgain ? 'Grant Camera Access' : 'Open Settings'}
        </Button>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.cameraContainer}>
        {isActive ? (
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['ean13', 'upc_a', 'upc_e'] }}
            onBarcodeScanned={scanState === 'idle' ? handleBarcodeScanned : undefined}
          />
        ) : (
          <View style={styles.camera} />
        )}
        {scanState === 'looking_up' && (
          <View style={styles.overlay}>
            <ActivityIndicator size="large" color="#fff" />
            <Text variant="bodyLarge" style={styles.overlayText}>
              Looking up barcode...
            </Text>
          </View>
        )}
      </View>

      {scanState === 'result' && preview && (
        <Surface style={styles.resultCard} elevation={2}>
          <View style={styles.resultRow}>
            {preview.thumb ? (
              <Image source={{ uri: preview.thumb }} style={styles.resultThumb} />
            ) : null}
            <View style={styles.resultInfo}>
              <Text variant="titleMedium" numberOfLines={2}>
                {preview.title}
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                {preview.artist}
              </Text>
              {preview.year ? (
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {preview.year}
                </Text>
              ) : null}
              {!pressingConfirmed && (
                <Chip icon="help-circle-outline" compact style={styles.unconfirmedChip} textStyle={styles.chipText}>
                  Unconfirmed pressing
                </Chip>
              )}
            </View>
          </View>
          {settings.redApiKey ? (
            <View style={styles.redStatusRow}>
              {redLoading ? (
                <Chip icon="loading" compact>Checking RED...</Chip>
              ) : redStatus ? (
                <>
                  <Chip
                    icon={redStatus.uploaded ? 'check-circle' : 'progress-upload'}
                    compact
                    style={redStatus.uploaded ? undefined : { backgroundColor: theme.colors.secondary }}
                    textStyle={styles.chipText}
                  >
                    {redStatus.uploaded ? 'Already on RED' : 'Not found on RED'}
                  </Chip>
                  {redStatus.losslessMissing && (
                    <Chip icon="music-note-plus" compact style={{ backgroundColor: theme.dark ? '#4A3800' : '#FFF9C4' }} textStyle={styles.chipText}>
                      No FLAC yet
                    </Chip>
                  )}
                  {redStatus.trumpable && (
                    <Chip icon="chevron-double-up" compact style={{ backgroundColor: theme.dark ? '#4A3800' : '#FFF9C4' }} textStyle={styles.chipText}>
                      Trumpable
                    </Chip>
                  )}
                  {redStatus.requests[0] && (
                    <Chip icon={({ size, color }) => <FontAwesome6 name="sack-dollar" size={size - 4} color={color} />} compact>
                      Request exists: {redStatus.requests[0].formatList}
                    </Chip>
                  )}
                  {(redStatus.otherEditionCount ?? 0) > 0 && (
                    <Chip icon="disc" compact>
                      {redStatus.otherEditionCount} other edition{redStatus.otherEditionCount !== 1 ? 's' : ''}
                    </Chip>
                  )}
                </>
              ) : redFailed ? (
                <Chip icon="alert-circle-outline" compact>Couldn't check RED</Chip>
              ) : null}
            </View>
          ) : null}
          <View style={styles.resultActions}>
            <Button mode="outlined" onPress={handleDismiss}>
              Dismiss
            </Button>
            <Button mode="contained" onPress={handleAdd}>
              Add to Collection
            </Button>
          </View>
        </Surface>
      )}

      <ReleasePicker
        visible={scanState === 'disambiguate'}
        candidates={candidates}
        coverMap={coverMap}
        loading={pickerLoading}
        error={pickerError?.message ?? null}
        errorRemovable={!!pickerError?.removable}
        onSelect={handleSelectRelease}
        onUnsure={handleUnsure}
        onDismiss={handlePickerDismiss}
        onErrorDismiss={handlePickerErrorDismiss}
      />

      {scanState === 'idle' && !result && lastAdded && (
        <Surface style={styles.lastAdded} elevation={1}>
          <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            Last added
          </Text>
          <View style={styles.resultRow}>
            {lastAdded.thumb ? (
              <Image source={{ uri: lastAdded.thumb }} style={styles.smallThumb} />
            ) : null}
            <View style={styles.resultInfo}>
              <Text variant="bodyMedium" numberOfLines={1}>
                {lastAdded.artist} - {lastAdded.title}
              </Text>
            </View>
          </View>
        </Surface>
      )}

      {/* Remount for each new message so it gets its own timer */}
      <Snackbar
        key={duplicateBarcode ?? snackbar}
        visible={!!snackbar}
        onDismiss={() => {
          setSnackbar('');
          setDuplicateBarcode(null);
        }}
        duration={duplicateBarcode ? 5000 : 2500}
        action={duplicateBarcode ? {
          label: 'Look up anyway',
          onPress: () => lookupBarcode(duplicateBarcode, { skipDuplicateCheck: true }),
        } : undefined}
      >
        {snackbar}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  permText: {
    marginTop: 16,
    textAlign: 'center',
  },
  permButton: {
    marginTop: 16,
  },
  cameraContainer: {
    flex: 1,
    overflow: 'hidden',
    margin: 16,
    borderRadius: 16,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  overlayText: {
    color: '#fff',
    marginTop: 12,
  },
  resultCard: {
    margin: 16,
    padding: 16,
    borderRadius: 12,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  resultThumb: {
    width: 64,
    height: 64,
    borderRadius: 4,
  },
  resultInfo: {
    flex: 1,
    marginLeft: 12,
  },
  resultActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 12,
  },
  redStatusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  chipText: {
    fontSize: 11,
  },
  unconfirmedChip: {
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  lastAdded: {
    margin: 16,
    marginTop: 0,
    padding: 12,
    borderRadius: 12,
  },
  smallThumb: {
    width: 40,
    height: 40,
    borderRadius: 4,
    marginTop: 4,
  },
});
