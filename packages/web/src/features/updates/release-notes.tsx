import { Fragment, useMemo, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { parseMarkdown, type Block, type Inline } from './markdown';

/**
 * A release's notes, read from Markdown and rendered as React text — never as HTML — so a tag
 * in the notes shows as typed and nothing in them can run or navigate.
 */
export function ReleaseNotes({ markdown, className }: { markdown: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  if (blocks.length === 0) {
    return <p className={cn('text-muted-foreground text-[13px]', className)}>This release has no notes.</p>;
  }
  return (
    <div className={cn('selectable flex flex-col gap-2 text-[13px] leading-relaxed', className)}>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading': {
      // Release bodies start at ## or ###; inside a dialog every level reads as a small heading.
      const Tag = block.level <= 3 ? 'h3' : 'h4';
      return (
        <Tag
          className={cn(
            'text-foreground mt-2 font-semibold first:mt-0',
            block.level <= 2 ? 'text-[14px]' : block.level === 3 ? 'text-[13px]' : 'text-muted-foreground text-xs',
          )}
        >
          <Inlines nodes={block.children} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p className="text-foreground/90">
          <Inlines nodes={block.children} />
        </p>
      );
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag
          className={cn(
            'text-foreground/90 marker:text-muted-foreground flex flex-col gap-1 pl-5',
            block.ordered ? 'list-decimal' : 'list-disc',
          )}
        >
          {block.items.map((item, i) => (
            <li key={i} className="pl-0.5">
              <Inlines nodes={item} />
            </li>
          ))}
        </Tag>
      );
    }
    case 'code':
      return (
        <pre className="bg-muted/70 overflow-x-auto rounded-md px-3 py-2 font-mono text-xs shadow-[inset_0_0_0_1px_var(--edge)]">
          {block.text}
        </pre>
      );
  }
}

function Inlines({ nodes }: { nodes: Inline[] }): ReactNode {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case 'text':
        return <Fragment key={i}>{node.text}</Fragment>;
      case 'code':
        return (
          <code key={i} className="bg-muted rounded-[4px] px-1 py-px font-mono text-[0.92em]">
            {node.text}
          </code>
        );
      case 'strong':
        return (
          <strong key={i} className="text-foreground font-semibold">
            <Inlines nodes={node.children} />
          </strong>
        );
      case 'em':
        return (
          <em key={i}>
            <Inlines nodes={node.children} />
          </em>
        );
    }
  });
}
