import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

/**
 * Syntax colors from the Kleos code tokens (keyword, string, number, function), applied as
 * classes from the lang-sql syntax tree so they follow light and dark mode through CSS
 * variables. Identifiers followed by "(" read as function calls.
 */
const classes: Record<string, string> = {
  Keyword: 'cm-k-keyword',
  Type: 'cm-k-keyword',
  Bool: 'cm-k-keyword',
  Null: 'cm-k-keyword',
  String: 'cm-k-string',
  Bytes: 'cm-k-string',
  Number: 'cm-k-number',
  Bits: 'cm-k-number',
  Builtin: 'cm-k-function',
  LineComment: 'cm-k-comment',
  BlockComment: 'cm-k-comment',
};

function highlight(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        let cls = classes[node.name];
        if (!cls && node.name === 'Identifier') {
          const after = doc.sliceString(node.to, Math.min(doc.length, node.to + 1));
          if (after === '(') cls = 'cm-k-function';
        }
        if (cls) builder.add(node.from, node.to, Decoration.mark({ class: cls }));
      },
    });
  }
  return builder.finish();
}

export const kleosHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = highlight(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = highlight(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Marks the statement that last ran (subtle background and a left rule on its lines). */
export const setRanRange = StateEffect.define<{ from: number; to: number } | null>();

const ranLine = Decoration.line({ class: 'cm-ran-statement' });

export const ranStatementField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setRanRange)) continue;
      if (!e.value) {
        next = Decoration.none;
        continue;
      }
      const doc = tr.state.doc;
      const from = Math.min(e.value.from, doc.length);
      const to = Math.min(e.value.to, doc.length);
      const builder = new RangeSetBuilder<Decoration>();
      for (let line = doc.lineAt(from).number; line <= doc.lineAt(to).number; line += 1) {
        const l = doc.line(line);
        builder.add(l.from, l.from, ranLine);
      }
      next = builder.finish();
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Editor chrome matching the design: Geist Mono 13/22, quiet gutter, wavy error underline. */
export const kleosEditorTheme: Extension = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--background)', color: 'var(--foreground)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '22px' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--foreground)' },
  '.cm-gutters': {
    backgroundColor: 'var(--background)',
    color: 'var(--muted-foreground)',
    border: 'none',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '34px', padding: '0 12px 0 8px', fontSize: '12px' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)', fontWeight: '500' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--brand-text)', borderLeftWidth: '2px' },
  '.cm-ran-statement': {
    backgroundColor: 'color-mix(in srgb, var(--brand) 5%, transparent)',
    boxShadow: 'inset 2px 0 0 color-mix(in srgb, var(--brand-text) 70%, transparent)',
  },
  '.cm-k-keyword': { color: 'var(--code-keyword)', fontWeight: '500' },
  '.cm-k-string': { color: 'var(--code-string)' },
  '.cm-k-number': { color: 'var(--code-number)' },
  '.cm-k-function': { color: 'var(--code-function)' },
  '.cm-k-comment': { color: 'var(--muted-foreground)', fontStyle: 'italic' },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--destructive)',
    textDecorationThickness: '1.5px',
    textUnderlineOffset: '3px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: 'none',
    borderRadius: '8px',
    boxShadow: '0 0 0 1px var(--edge), var(--elev-3)',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': { padding: '4px', fontFamily: 'var(--font-mono)' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 8px !important', borderRadius: '5px', lineHeight: '1.4' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--brand-soft)',
    color: 'var(--foreground)',
  },
  '.cm-completionDetail': { marginLeft: '12px', color: 'var(--muted-foreground)', fontStyle: 'normal' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600', color: 'var(--brand-text)' },
  '.cm-diagnostic': { padding: '6px 10px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--destructive)' },
  // Hovered diagnostic: a faint red wash in the token colors instead of lint's default amber.
  '.cm-lintRange-active': { backgroundColor: 'color-mix(in srgb, var(--destructive) 10%, transparent)' },
});
