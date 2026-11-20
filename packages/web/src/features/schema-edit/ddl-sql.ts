import { tokenizeSql, type SqlToken } from '@/features/data/pending-sql';

const ddlKeywords =
  /^(BEGIN|COMMIT|CREATE|ALTER|DROP|RENAME|ADD|TABLE|COLUMN|INDEX|TO|TYPE|USING|SET|NOT|NULL|DEFAULT|PRIMARY|KEY|UNIQUE|ON|CASCADE|RESTRICT|CONSTRAINT|IF|EXISTS|COLLATE)$/;

/** The data tab's review tokenizer, with the keywords of the statements schema changes become. */
export function tokenizeDdl(sql: string): SqlToken[] {
  return tokenizeSql(sql).map((t) => (t.kind === 'plain' && ddlKeywords.test(t.text) ? { ...t, kind: 'keyword' } : t));
}
