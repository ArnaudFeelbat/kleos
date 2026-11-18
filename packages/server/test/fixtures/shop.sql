-- A small shop for introspection, foreign keys, editing and paging.
create schema shop;

create type shop.order_status as enum ('pending', 'paid', 'shipped', 'cancelled');

create table shop.customers (
  id bigint generated always as identity primary key,
  email text not null unique,
  name text,
  created_at timestamptz not null default now()
);
comment on table shop.customers is 'People who buy things';

create table shop.orders (
  id serial primary key,
  customer_id bigint not null references shop.customers (id),
  status shop.order_status not null default 'pending',
  total numeric(12, 2) not null default 0,
  note text
);
create index orders_customer_idx on shop.orders (customer_id);

create table shop.order_items (
  order_id int not null references shop.orders (id) on delete cascade,
  line int not null,
  product text not null,
  qty int not null check (qty > 0),
  primary key (order_id, line)
);

-- No primary key: read-only in v1.
create table shop.audit_log (at timestamptz not null default now(), message text);

create view shop.order_totals as
  select o.customer_id, count(*) as orders, sum(o.total) as total
    from shop.orders o
   group by o.customer_id;

insert into shop.customers (email, name) values
  ('ada@example.com', 'Ada'),
  ('grace@example.com', 'Grace'),
  ('linus@example.com', null);

insert into shop.orders (customer_id, status, total, note) values
  (1, 'paid', 120.50, 'first'),
  (1, 'shipped', 80.00, null),
  (2, 'pending', 15.25, ''),
  (3, 'cancelled', 0, 'refunded');

insert into shop.order_items values
  (1, 1, 'Keyboard', 1),
  (1, 2, 'Mouse', 2),
  (2, 1, 'Monitor', 1),
  (3, 1, 'Cable', 3);

insert into shop.audit_log (message) values ('seeded'), ('again');

-- 1000 rows for paging; updating every third row moves it to the end of the heap,
-- so a sequential scan no longer returns them in id order.
create table shop.paging (id int primary key, grp int not null, label text not null);
insert into shop.paging select g, g % 7, 'row ' || g from generate_series(1, 1000) g;
update shop.paging set label = label || '!' where id % 3 = 0;

-- An account table for lock tests.
create table shop.accounts (id int primary key, balance numeric not null);
insert into shop.accounts values (1, 100), (2, 200);

analyze;
