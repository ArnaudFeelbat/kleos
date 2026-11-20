import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SnippetEditor } from './snippet-editor';

beforeAll(() => {
  // CodeMirror measures text ranges; jsdom lacks these.
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  Range.prototype.getClientRects ??= empty as unknown as Range['getClientRects'];
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

describe('SnippetEditor', () => {
  it('shows the body in a named SQL editor and submits on ⌘↵', () => {
    const onSubmit = vi.fn();
    render(<SnippetEditor value="select 1" onChange={() => {}} onSubmit={onSubmit} label="Snippet SQL" />);
    const content = screen.getByRole('textbox', { name: 'Snippet SQL' });
    expect(content).toHaveTextContent('select 1');
    // jsdom is not a Mac: CodeMirror reads Mod as Ctrl.
    fireEvent.keyDown(content, { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
