import React, { useState, useEffect } from 'react';
import { Keyboard } from 'react-native';
import { Portal, Dialog, TextInput, HelperText, Button } from 'react-native-paper';

interface Props {
  visible: boolean;
  onSubmit: (barcode: string) => void;
  onDismiss: () => void;
}

// EAN-8, UPC-A, EAN-13 and GTIN-14
const BARCODE_PATTERN = /^\d{8,14}$/;

export default function BarcodeDialog({ visible, onSubmit, onDismiss }: Props) {
  const [text, setText] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Start empty each time the dialog opens
  const [prevVisible, setPrevVisible] = useState(visible);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (visible) {
      setText('');
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

  // Printed barcodes are often spaced out, like 0 12345 67890 5
  const digits = text.replace(/\s/g, '');
  // The scanner reports EAN-13 codes starting with 0 as 12-digit UPC-A
  const barcode = digits.length === 13 && digits.startsWith('0') ? digits.slice(1) : digits;
  const valid = BARCODE_PATTERN.test(barcode);

  const submit = () => {
    if (visible && valid) onSubmit(barcode);
  };

  return (
    <Portal>
      <Dialog
        visible={visible}
        onDismiss={onDismiss}
        style={keyboardHeight ? { marginBottom: keyboardHeight } : undefined}
      >
        <Dialog.Title>Enter barcode</Dialog.Title>
        <Dialog.Content>
          <TextInput
            mode="outlined"
            label="Barcode"
            value={text}
            onChangeText={setText}
            onSubmitEditing={submit}
            keyboardType="number-pad"
            returnKeyType="search"
            autoFocus
          />
          <HelperText type="info">
            The 8 to 14 digits under the bars
          </HelperText>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Cancel</Button>
          <Button onPress={submit} disabled={!valid}>
            Look up
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
