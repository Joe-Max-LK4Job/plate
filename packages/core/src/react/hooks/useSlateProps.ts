import React from 'react';

import type { Editor, TSelection, Value } from '@udecode/slate';
import type { UnknownObject } from '@udecode/utils';

import { useEditorRef, usePlateSelectors } from '../stores';
import { pipeOnChange } from '../utils/pipeOnChange';

interface SlateProps extends UnknownObject {
  children: React.ReactNode;
  editor: Editor;
  initialValue: Value;
  onChange?: (value: Value) => void;
  onSelectionChange?: (selection: TSelection) => void;
  onValueChange?: (value: Value) => void;
}

/** Get Slate props stored in a global store. */
export const useSlateProps = ({
  id,
}: {
  id?: string;
}): Omit<SlateProps, 'children'> => {
  const editor = useEditorRef(id);
  const onChangeProp = usePlateSelectors(id).onChange();
  const onValueChangeProp = usePlateSelectors(id).onValueChange();
  const onSelectionChangeProp = usePlateSelectors(id).onSelectionChange();

  const onChange = React.useCallback(
    (newValue: Value) => {
      const eventIsHandled = pipeOnChange(editor, newValue);

      if (!eventIsHandled) {
        onChangeProp?.({ editor, value: newValue });
      }
    },
    [editor, onChangeProp]
  );

  const onValueChange: SlateProps['onValueChange'] = React.useMemo(
    () => (value) => {
      onValueChangeProp?.({ editor, value });
    },
    [editor, onValueChangeProp]
  );

  const onSelectionChange: SlateProps['onSelectionChange'] = React.useMemo(
    () => (selection: TSelection) => {
      onSelectionChangeProp?.({ editor, selection });
    },
    [editor, onSelectionChangeProp]
  );

  return React.useMemo(() => {
    return {
      key: editor.key,
      editor,
      initialValue: editor.children,
      value: editor.children,
      onChange,
      onSelectionChange,
      onValueChange,
    };
  }, [editor, onChange, onSelectionChange, onValueChange]);
};
