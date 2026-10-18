import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, useTheme } from 'react-native-paper';

export default function EmptyCollection({ loadError, listName }: { loadError?: boolean; listName?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.container}>
      <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurfaceVariant }]}>
        {loadError ? "Couldn't load your collection" : listName ? `No releases in ${listName}` : 'No releases yet'}
      </Text>
      <Text
        variant="bodyMedium"
        style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}
      >
        {loadError
          ? "Restart the app to try again. New scans won't be saved until it loads."
          : listName
            ? 'Swipe to the Scan tab to add releases to this list.'
            : 'Swipe to the Scan tab to scan your first release!'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  title: {
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 8,
    textAlign: 'center',
  },
});
