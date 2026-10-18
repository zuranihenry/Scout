import React from 'react';
import { Appbar, Button, useTheme } from 'react-native-paper';

interface Props {
  count: number;
  onDelete: () => void;
  onCancel: () => void;
  onMove: () => void;
  onLookupRed: () => void;
  redLookupLoading: boolean;
  hasRedApiKey: boolean;
}

export default function SelectionToolbar({
  count,
  onDelete,
  onCancel,
  onMove,
  onLookupRed,
  redLookupLoading,
  hasRedApiKey,
}: Props) {
  const theme = useTheme();

  return (
    <Appbar.Header statusBarHeight={0} style={{ backgroundColor: theme.colors.elevation.level2 }}>
      <Appbar.Action icon="close" onPress={onCancel} accessibilityLabel="Cancel selection" />
      <Appbar.Content title={`${count} selected`} />
      {hasRedApiKey && (
        <Button
          mode="text"
          onPress={onLookupRed}
          loading={redLookupLoading}
          disabled={redLookupLoading || count === 0}
          icon="magnify"
          compact
        >
          Search on RED
        </Button>
      )}
      <Appbar.Action icon="folder-move-outline" onPress={onMove} accessibilityLabel="Move to another list" />
      <Button mode="text" onPress={onDelete} textColor={theme.colors.error}>
        Delete
      </Button>
    </Appbar.Header>
  );
}
