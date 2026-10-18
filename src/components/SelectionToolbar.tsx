import React from 'react';
import { Appbar, Button, useTheme } from 'react-native-paper';

interface Props {
  count: number;
  onDelete: () => void;
  onCancel: () => void;
  onMove: () => void;
  onLookup: () => void;
  lookupLoading: boolean;
  trackerNames: string;  // The trackers to search, or empty for none
}

export default function SelectionToolbar({
  count,
  onDelete,
  onCancel,
  onMove,
  onLookup,
  lookupLoading,
  trackerNames,
}: Props) {
  const theme = useTheme();

  return (
    <Appbar.Header statusBarHeight={0} style={{ backgroundColor: theme.colors.elevation.level2 }}>
      <Appbar.Action icon="close" onPress={onCancel} accessibilityLabel="Cancel selection" />
      <Appbar.Content title={`${count} selected`} />
      {!!trackerNames && (
        <Button
          mode="text"
          onPress={onLookup}
          loading={lookupLoading}
          disabled={lookupLoading || count === 0}
          icon="magnify"
          compact
        >
          {`Search on ${trackerNames}`}
        </Button>
      )}
      <Appbar.Action icon="folder-move-outline" onPress={onMove} accessibilityLabel="Move to another list" />
      <Button mode="text" onPress={onDelete} textColor={theme.colors.error}>
        Delete
      </Button>
    </Appbar.Header>
  );
}
