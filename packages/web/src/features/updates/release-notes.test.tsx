import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';
import { ReleaseNotes } from './release-notes';

describe('parseMarkdown', () => {
  it('reads headings, lists, paragraphs and fenced code', () => {
    const blocks = parseMarkdown(
      [
        '## Kleos 0.5.1',
        '',
        'Une version de *correction*.',
        'Suite du paragraphe.',
        '',
        '### Corrigé',
        '- un',
        '* deux',
        '  suite de deux',
        '',
        '1. premier',
        '2) second',
        '',
        '```sql',
        'select 1;',
        '```',
        '---',
        '> cité',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'heading', 'list', 'list', 'code', 'paragraph']);
    expect(blocks[0]).toEqual({ kind: 'heading', level: 2, children: [{ kind: 'text', text: 'Kleos 0.5.1' }] });
    expect(blocks[1]).toEqual({
      kind: 'paragraph',
      children: [
        { kind: 'text', text: 'Une version de ' },
        { kind: 'em', children: [{ kind: 'text', text: 'correction' }] },
        { kind: 'text', text: '. Suite du paragraphe.' },
      ],
    });
    expect(blocks[3]).toEqual({
      kind: 'list',
      ordered: false,
      items: [[{ kind: 'text', text: 'un' }], [{ kind: 'text', text: 'deux suite de deux' }]],
    });
    expect(blocks[4]).toMatchObject({ kind: 'list', ordered: true });
    expect(blocks[5]).toEqual({ kind: 'code', text: 'select 1;' });
    expect(blocks[6]).toEqual({ kind: 'paragraph', children: [{ kind: 'text', text: 'cité' }] });
  });

  it('reads bold, inline code and links (text only); unmatched markers stay as typed', () => {
    expect(
      parseInline('**Données** : `LIMIT 1000`, voir [la doc](https://example.com) et <https://github.com>'),
    ).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'Données' }] },
      { kind: 'text', text: ' : ' },
      { kind: 'code', text: 'LIMIT 1000' },
      { kind: 'text', text: ', voir la doc et https://github.com' },
    ]);
    expect(parseInline('2 * 3 = 6, snake_case_name and **open')).toEqual([
      { kind: 'text', text: '2 * 3 = 6, snake_case_name and **open' },
    ]);
    // Nothing inside code is Markdown.
    expect(parseInline('`**not bold**`')).toEqual([{ kind: 'code', text: '**not bold**' }]);
  });
});

describe('ReleaseNotes', () => {
  it('renders headings, lists, bold and code as elements', () => {
    render(<ReleaseNotes markdown={'### Ajouté\n- **Réglages** : la fenêtre `⌘,`\n- Vérification des mises à jour'} />);
    expect(screen.getByRole('heading', { name: 'Ajouté' })).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector('strong')).toHaveTextContent('Réglages');
    expect(items[0]!.querySelector('code')).toHaveTextContent('⌘,');
  });

  it('shows HTML and script tags as text: nothing in the notes becomes markup', () => {
    const hostile = [
      '<script>window.pwned = true</script>',
      '',
      '<img src=x onerror="window.pwned = true"> **<b>gras</b>**',
      '',
      '[click](javascript:alert(1)) &amp; <a href="https://evil.example">lien</a>',
    ].join('\n');
    const { container } = render(<ReleaseNotes markdown={hostile} />);
    expect(container.querySelector('script, img, a, b, iframe')).toBeNull();
    expect(container).toHaveTextContent('<script>window.pwned = true</script>');
    expect(container).toHaveTextContent('<img src=x onerror="window.pwned = true"> <b>gras</b>');
    // A link keeps its text only; entities are not decoded.
    expect(container).toHaveTextContent('click &amp; <a href="https://evil.example">lien</a>');
    expect(container.textContent).not.toContain('javascript:');
    expect((window as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it('says so when a release has no notes', () => {
    render(<ReleaseNotes markdown={'  \n'} />);
    expect(screen.getByText('This release has no notes.')).toBeInTheDocument();
  });
});
