import { z } from 'zod';

export * from './connection';
export * from './errors';
export * from './grid';
export * from './jobs';
export * from './query';
export * from './routes';
export * from './rows';
export * from './schema';
export * from './release';
export * from './settings';
export * from './settings-patch';
export * from './sql';
export * from './stats';
export * from './window-state';

/** GET /api/health */
export const Health = z.object({
  ok: z.literal(true),
  version: z.string(),
});
export type Health = z.infer<typeof Health>;
