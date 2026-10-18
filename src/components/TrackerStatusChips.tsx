import React from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Chip, ActivityIndicator, useTheme } from 'react-native-paper';
import { FontAwesome6 } from '@expo/vector-icons';
import { TRACKERS, type TrackerId } from '../services/gazelle';
import type { TrackerStatus } from '../types';

export function formatBounty(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

interface Props {
  tracker: TrackerId;
  status?: TrackerStatus | null;
  checking?: boolean;
  failed?: boolean;
  // The scan result card, or the badges on a collapsed album card
  variant: 'result' | 'badge';
  style?: StyleProp<ViewStyle>;
}

export default function TrackerStatusChips({ tracker, status, checking, failed, variant, style }: Props) {
  const theme = useTheme();
  const name = TRACKERS[tracker].name;
  const badge = variant === 'badge';
  const chipStyle = badge ? styles.badgeChip : undefined;
  const highlight = { backgroundColor: theme.dark ? '#4A3800' : '#FFF9C4' };

  if (checking) {
    return (
      <View style={style}>
        {badge ? (
          <Chip icon={({ size }) => <ActivityIndicator size={size} />} compact style={chipStyle} textStyle={styles.chipText}>
            Checking {name}...
          </Chip>
        ) : (
          <Chip icon="loading" compact>Checking {name}...</Chip>
        )}
      </View>
    );
  }
  if (!status) {
    return failed ? (
      <View style={style}>
        <Chip icon="alert-circle-outline" compact>Couldn't check {name}</Chip>
      </View>
    ) : null;
  }

  const request = status.requests[0];
  return (
    <View style={style}>
      <Chip
        icon={status.uploaded ? 'check-circle' : 'progress-upload'}
        compact
        style={[chipStyle, !status.uploaded && { backgroundColor: theme.colors.secondary }]}
        textStyle={styles.chipText}
      >
        {status.uploaded ? `Already on ${name}` : badge ? `Not on ${name}` : `Not found on ${name}`}
      </Chip>
      {status.losslessMissing && (
        <Chip icon="music-note-plus" compact style={[chipStyle, highlight]} textStyle={styles.chipText}>
          No FLAC yet
        </Chip>
      )}
      {status.trumpable && (
        <Chip icon="chevron-double-up" compact style={[chipStyle, highlight]} textStyle={styles.chipText}>
          Trumpable
        </Chip>
      )}
      {status.reported && (
        <Chip icon="flag-outline" compact style={[chipStyle, highlight]} textStyle={styles.chipText}>
          Reported
        </Chip>
      )}
      {request && (
        <Chip
          icon={({ size, color }) => <FontAwesome6 name="sack-dollar" size={size - 4} color={color} />}
          compact
          style={chipStyle}
          textStyle={badge ? styles.chipText : undefined}
        >
          {badge
            ? [request.formatList, formatBounty(request.bounty)].filter(Boolean).join(' - ')
            : request.formatList ? `Request exists: ${request.formatList}` : 'Request exists'}
        </Chip>
      )}
      {!badge && (status.otherEditionCount ?? 0) > 0 && (
        <Chip icon="disc" compact>
          {status.otherEditionCount} other edition{status.otherEditionCount !== 1 ? 's' : ''}
        </Chip>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  badgeChip: {
    maxWidth: '100%',
  },
  chipText: {
    fontSize: 11,
  },
});
