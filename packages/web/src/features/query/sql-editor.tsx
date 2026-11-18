import { PostgreSQL, sql, type SQLNamespace } from '@codemirror/lang-sql';
import { linter, setDiagnostics } from '@codemirror/lint';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { kleosEditorTheme, kleosHighlight, ranStatementField, setRanRange } from './editor-extensions';

export type ErrorMark = { from: number; to: number; message: string };

type SqlEditorProps = {
  value: string;
  onChange(value: string): void;
  schema: SQLNamespace;
  defaultSchema: string | undefined;
  onRun(): void;
  onExplain(): void;
  /** Statement that last ran, highlighted. */
  ranRange: { from: number; to: number } | null;
  /** Failing token of the last run, underlined as an error diagnostic. */
  errorMark: ErrorMark | null;
  onView(view: EditorView | null): void;
};

const RUN_EVENT = 'kleos:run';
const EXPLAIN_EVENT = 'kleos:explain';

/** ⌘↵ / ⌘E, raised as DOM events so the component handles them with its current callbacks. */
const runKeys = Prec.highest(
  keymap.of([
    {
      key: 'Mod-Enter',
      run: (view) => {
        view.dom.dispatchEvent(new CustomEvent(RUN_EVENT, { bubbles: true }));
        return true;
      },
    },
    {
      key: 'Mod-e',
      run: (view) => {
        view.dom.dispatchEvent(new CustomEvent(EXPLAIN_EVENT, { bubbles: true }));
        return true;
      },
    },
  ]),
);

/**
 * The lint extension lives in the base configuration. setDiagnostics() would otherwise add it
 * with StateEffect.appendConfig, and @uiw/react-codemirror drops appended config on every
 * StateEffect.reconfigure it dispatches (it reconfigures whenever a prop identity changes), which
 * silently removed the error underline after the next re-render (e.g. switching workspace tabs).
 */
const lintState = linter(null);

/** Stable identity: an inline object would make the wrapper reconfigure on every render. */
const basicSetup = {
  foldGutter: false,
  highlightActiveLine: false,
  highlightSelectionMatches: false,
  syntaxHighlighting: false,
} as const;

function clamp(view: EditorView, n: number) {
  return Math.max(0, Math.min(n, view.state.doc.length));
}

function applyMarks(view: EditorView, ran: SqlEditorProps['ranRange'], err: ErrorMark | null) {
  const effects = setRanRange.of(ran ? { from: clamp(view, ran.from), to: clamp(view, ran.to) } : null);
  view.dispatch({ effects });
  const diagnostics = err
    ? [{ from: clamp(view, err.from), to: clamp(view, err.to), severity: 'error' as const, message: err.message }]
    : [];
  view.dispatch(setDiagnostics(view.state, diagnostics));
}

/**
 * CodeMirror with the PostgreSQL dialect and schema autocomplete. ⌘↵ runs, ⌘E explains;
 * the last statement run is highlighted and an error position is underlined.
 */
export function SqlEditor({
  value,
  onChange,
  schema,
  defaultSchema,
  onRun,
  onExplain,
  ranRange,
  errorMark,
  onView,
}: SqlEditorProps) {
  const viewRef = useRef<EditorView | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const run = () => onRun();
    const explain = () => onExplain();
    el.addEventListener(RUN_EVENT, run);
    el.addEventListener(EXPLAIN_EVENT, explain);
    return () => {
      el.removeEventListener(RUN_EVENT, run);
      el.removeEventListener(EXPLAIN_EVENT, explain);
    };
  }, [onRun, onExplain]);

  const extensions = useMemo(
    () => [
      sql({ dialect: PostgreSQL, schema, defaultSchema }),
      runKeys,
      ranStatementField,
      lintState,
      kleosHighlight,
      EditorView.contentAttributes.of({ 'aria-label': 'SQL editor' }),
    ],
    [schema, defaultSchema],
  );

  // The parent passes a new onChange each render; route it through a ref so the wrapper keeps
  // one callback and does not reconfigure the editor on every keystroke or tab switch.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  const stableOnChange = useCallback((next: string) => onChangeRef.current(next), []);

  // Re-mark after each run (new ranges come with a new run, so identity is enough).
  useEffect(() => {
    if (viewRef.current) applyMarks(viewRef.current, ranRange, errorMark);
  }, [ranRange, errorMark]);

  useEffect(() => () => onView(null), [onView]);

  return (
    <div ref={wrapRef} className="h-full min-h-0">
      <CodeMirror
        value={value}
        onChange={stableOnChange}
        theme={kleosEditorTheme}
        extensions={extensions}
        height="100%"
        className="h-full min-h-0"
        basicSetup={basicSetup}
        onCreateEditor={(view) => {
          viewRef.current = view;
          onView(view);
          applyMarks(view, ranRange, errorMark);
        }}
      />
    </div>
  );
}
