import React, { useState, useMemo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Portal, Dialog, List, Button } from 'react-native-paper';
import { useCollection } from '../context/CollectionContext';
import { countByList } from '../services/lists';
import ListNameDialog from './ListNameDialog';
import type { AlbumList } from '../types';

interface Props {
  visible: boolean;
  title: string;
  currentListId?: string;  // Shown but can't be picked
  onSelect: (list: AlbumList) => void;
  onDismiss: () => void;
}

export default function ListPickerDialog({ visible, title, currentListId, onSelect, onDismiss }: Props) {
  const { albums, lists, createList } = useCollection();
  const [naming, setNaming] = useState(false);
  const counts = useMemo(() => countByList(albums), [albums]);

  const handleCreate = (name: string) => {
    setNaming(false);
    onSelect(createList(name));
  };

  return (
    <>
      <Portal>
        <Dialog visible={visible && !naming} onDismiss={onDismiss} style={styles.dialog}>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.ScrollArea style={styles.scrollArea}>
            <ScrollView>
              {lists.map((list) => {
                const count = counts.get(list.id) ?? 0;
                return (
                  <List.Item
                    key={list.id}
                    title={list.name}
                    description={`${count} release${count !== 1 ? 's' : ''}`}
                    left={(props) => <List.Icon {...props} icon="folder-outline" />}
                    onPress={() => onSelect(list)}
                    disabled={list.id === currentListId}
                    style={[styles.item, list.id === currentListId && styles.current]}
                  />
                );
              })}
              <List.Item
                title="New list"
                left={(props) => <List.Icon {...props} icon="folder-plus-outline" />}
                onPress={() => setNaming(true)}
                style={styles.item}
              />
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={onDismiss}>Cancel</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
      <ListNameDialog
        visible={visible && naming}
        onSubmit={handleCreate}
        onDismiss={() => setNaming(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  dialog: {
    maxHeight: '80%',
  },
  scrollArea: {
    paddingHorizontal: 0,
  },
  item: {
    paddingLeft: 8,
  },
  current: {
    opacity: 0.38,
  },
});
