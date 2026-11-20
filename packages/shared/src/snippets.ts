import { z } from 'zod';

/**
 * Reusable SQL snippets (0.7), kept in app.db and shared by every server: inserted at the cursor
 * from the query editor's side panel or from ⌘K ("Insert snippet: …").
 */
export const Snippet = z.object({
  id: z.string(),
  name: z.string().min(1),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Snippet = z.infer<typeof Snippet>;

export const SnippetInput = z.object({
  name: z.string().trim().min(1).max(200),
  body: z.string().max(100_000),
});
export type SnippetInput = z.infer<typeof SnippetInput>;
