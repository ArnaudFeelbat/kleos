import type { Column, ForeignKey, SchemaModel, Table } from '@kleos/shared';

/** Test-only builders for SchemaModel fixtures. */
export function col(name: string, type = 'integer', patch: Partial<Column> = {}): Column {
  return {
    name,
    type,
    typeName: type,
    typeOid: 23,
    typeCategory: 'N',
    nullable: false,
    default: null,
    identity: null,
    generated: false,
    ...patch,
  };
}

export function table(name: string, columns: Column[], patch: Partial<Table> = {}): Table {
  return {
    schema: 'public',
    name,
    kind: 'table',
    columns,
    primaryKey: columns[0] ? [columns[0].name] : [],
    indexes: [],
    constraints: [],
    rowEstimate: 100,
    totalBytes: 8192,
    comment: null,
    ...patch,
  };
}

export function fk(
  tableName: string,
  column: string,
  refTable: string,
  refColumn = 'id',
  patch: Partial<ForeignKey> = {},
): ForeignKey {
  return {
    name: `${tableName}_${column}_fkey`,
    schema: 'public',
    table: tableName,
    columns: [column],
    refSchema: 'public',
    refTable,
    refColumns: [refColumn],
    ...patch,
  };
}

/** customers <- orders <- order_items -> products -> categories (self-ref), plus a view and an enum. */
export function shopModel(): SchemaModel {
  return {
    schemas: ['public', 'sales'],
    tables: [
      table(
        'customers',
        [col('id', 'uuid'), col('email', 'text'), col('country', 'character(2)', { nullable: true })],
        {
          rowEstimate: 12_400,
        },
      ),
      table('orders', [col('id', 'bigint'), col('customer_id', 'uuid'), col('metadata', 'jsonb', { nullable: true })], {
        rowEstimate: 1_204_380,
        totalBytes: 412 * 1024 ** 2,
      }),
      table('order_items', [col('id', 'bigint'), col('order_id', 'bigint'), col('product_id', 'bigint')]),
      table('products', [col('id', 'bigint'), col('category_id'), col('tags', 'text[]', { nullable: true })], {
        rowEstimate: 2184,
      }),
      table('categories', [col('id'), col('name', 'text'), col('parent_id', 'integer', { nullable: true })], {
        rowEstimate: -1,
      }),
      table('invoices', [col('id'), col('order_id', 'bigint')], { schema: 'sales' }),
    ],
    views: [table('active_customers', [col('id', 'uuid')], { kind: 'view', primaryKey: [] })],
    foreignKeys: [
      fk('orders', 'customer_id', 'customers'),
      fk('order_items', 'order_id', 'orders'),
      fk('order_items', 'product_id', 'products'),
      fk('products', 'category_id', 'categories'),
      fk('categories', 'parent_id', 'categories'),
      fk('invoices', 'order_id', 'orders', 'id', { schema: 'sales' }),
    ],
    enums: [{ schema: 'public', name: 'order_status', values: ['pending', 'paid', 'shipped'] }],
    introspectedAt: '2026-11-18T12:00:00Z',
  };
}
