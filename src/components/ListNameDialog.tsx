import React, { useState, useEffect } from 'react';
import { Keyboard } from 'react-native';
import { Portal, Dialog, TextInput, HelperText, Button } from 'react-native-paper';
import { useCollection } from '../context/CollectionContext';
import { listNameError, MAX_LIST_NAME_LENGTH } from '../services/lists';
import type { AlbumList } from '../types';

interface Props {
  visible: boolean;
  list?: AlbumList;  // The list to rename, or none to create one
  onSubmit: (name: string) => void;
  onDismiss: () => void;
}

export default function ListNameDialog({ visible, list, onSubmit, onDismiss }: Props) {
  const { lists } = useCollection();
  const [name, setName] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Start from the list's name each time the dialog opens. Resetting the keyboard
  // offset here, not on close, keeps the dialog in place while it fades out
  const [prevVisible, setPrevVisible] = useState(visible);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (visible) {
      setName(list?.name ?? '');
      setKeyboardHeight(0);
    }
  }

  // Dialogs are centered on the screen, so move this one up out of the keyboard's way
  useEffect(() => {
    if (!visible) return;
    const show = Keyboard.addListener('keyboardDidShow', (e) => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [visible]);

  // While the dialog fades out after Create, lists already has the new name
  const error = visible ? listNameError(name, lists, list?.id) : null;

  const submit = () => {
    if (visible && !error) onSubmit(name.trim());
  };

  return (
    <Portal>
      <Dialog
        visible={visible}
        onDismiss={onDismiss}
        style={keyboardHeight ? { marginBottom: keyboardHeight } : undefined}
      >
        <Dialog.Title>{list ? 'Rename list' : 'New list'}</Dialog.Title>
        <Dialog.Content>
          <TextInput
            mode="outlined"
            label="Name"
            value={name}
            onChangeText={setName}
            onSubmitEditing={submit}
            maxLength={MAX_LIST_NAME_LENGTH}
            returnKeyType="done"
            autoFocus
          />
          <HelperText type="error" visible={!!name && !!error}>
            {error}
          </HelperText>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Cancel</Button>
          <Button onPress={submit} disabled={!!error}>
            {list ? 'Rename' : 'Create'}
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
