import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useEffect, useMemo, useRef } from 'react';
import { kleosEditorTheme, kleosHighlight } from '@/features/query/editor-extensions';

type SnippetEditorProps = {
  value: string;
  onChange(value: string): void;
  /** ⌘↵ inside the editor. */
  onSubmit(): void;
  /** Accessible name of the editing surface. */
  label: string;
};

const SUBMIT_EVENT = 'kleos:snippet-submit';

/** ⌘↵, raised as a DOM event so the component handles it with its current callback. */
const submitKey = Prec.highest(
  keymap.of([
    {
      key: 'Mod-Enter',
      run: (view) => {
        view.dom.dispatchEvent(new CustomEvent(SUBMIT_EVENT, { bubbles: true }));
        return true;
      },
    },
  ]),
);

/** Stable identity: an inline object would make the wrapper reconfigure on every render. */
const basicSetup = {
  foldGutter: false,
  highlightActiveLine: false,
  highlightSelectionMatches: false,
  syntaxHighlighting: false,
  autocompletion: false,
} as const;

/** A small CodeMirror with the query editor's dialect, colors and theme, for a snippet's body. */
export function SnippetEditor({ value, onChange, onSubmit, label }: SnippetEditorProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const submit = () => onSubmit();
    el.addEventListener(SUBMIT_EVENT, submit);
    return () => el.removeEventListener(SUBMIT_EVENT, submit);
  }, [onSubmit]);

  const extensions = useMemo(
    () => [
      sql({ dialect: PostgreSQL }),
      kleosHighlight,
      submitKey,
      EditorView.contentAttributes.of({ 'aria-label': label }),
    ],
    [label],
  );
  return (
    <div
      ref={wrapRef}
      className="border-input bg-card focus-within:border-brand focus-within:ring-ring/25 h-44 overflow-hidden rounded-md border focus-within:ring-[3px] dark:bg-white/[0.03]"
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={kleosEditorTheme}
        extensions={extensions}
        height="100%"
        className="h-full min-h-0"
        basicSetup={basicSetup}
      />
    </div>
  );
}
