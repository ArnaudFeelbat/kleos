import type { Hono } from 'hono';
import { SnippetInput, type Snippet } from '@kleos/shared';
import type { ServerDeps } from '../http/deps';
import { jsonBody } from './validation';

/** Reusable SQL snippets (0.7), shared by every server. */
export function registerSnippetRoutes(api: Hono, deps: ServerDeps): void {
  const { store } = deps;

  api.get('/snippets', (c) => c.json<Snippet[]>(store.listSnippets()));

  api.post('/snippets', async (c) => {
    const input = await jsonBody(c, SnippetInput);
    return c.json<Snippet>(store.createSnippet(input));
  });

  api.put('/snippets/:id', async (c) => {
    const input = await jsonBody(c, SnippetInput);
    return c.json<Snippet>(store.updateSnippet(c.req.param('id'), input));
  });

  api.delete('/snippets/:id', (c) => {
    store.deleteSnippet(c.req.param('id'));
    return c.body(null, 204);
  });
}
