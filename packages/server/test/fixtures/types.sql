-- One table per type family of the spec's "Postgres type handling" section.
create schema types;

create table types.ints (id int primary key, i2 int2, i4 int4, i8 int8);
insert into types.ints values
  (1, 32767, 2147483647, 9007199254740993),
  (2, -32768, -2147483648, -9223372036854775808),
  (3, null, null, null);

create table types.numerics (id int primary key, n numeric, n2 numeric(12, 2), f4 float4, f8 float8);
insert into types.numerics values
  (1, 12345678901234567890.123456789, 1234567890.12, 3.14159, 0.1),
  (2, 'NaN', null, 'Infinity', '-Infinity'),
  (3, null, null, null, null);

create table types.texts (id int primary key, t text, v varchar(20));
insert into types.texts values
  (1, 'hello', 'world'),
  (2, '', ''),
  (3, null, null),
  (4, E'line one\nline two', 'ünïcödé ✓'),
  (5, '100%_done', 'a_b'),
  (6, '100 percent done', 'ab');

create table types.bools (id int primary key, b bool);
insert into types.bools values (1, true), (2, false), (3, null);

create table types.dates (id int primary key, d date);
insert into types.dates values (1, '2024-02-29'), (2, 'infinity'), (3, null);

create table types.timestamps (id int primary key, ts timestamp);
insert into types.timestamps values (1, '2024-02-29 13:45:01.123456'), (2, null);

create table types.timestamptzs (id int primary key, tstz timestamptz);
insert into types.timestamptzs values (1, '2024-06-01 12:00:00+00'), (2, null);

create table types.jsons (id int primary key, j json, jb jsonb);
insert into types.jsons values
  (1, '{"b": 1,  "a": [1, 2]}', '{"b": 1,  "a": [1, 2]}'),
  (2, '{"n": 12345678901234567890}', '{"n": 12345678901234567890}'),
  (3, null, 'null');

create table types.arrays (id int primary key, ints int[], texts text[], grid int[][]);
insert into types.arrays values
  (1, '{1,2,3}', '{a,"b c",NULL}', '{{1,2},{3,4}}'),
  (2, '{}', null, null);

create table types.uuids (id int primary key, u uuid);
insert into types.uuids values (1, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'), (2, null);

create type types.mood as enum ('sad', 'ok', 'happy');
create table types.enums (id int primary key, m types.mood);
insert into types.enums values (1, 'happy'), (2, 'sad'), (3, null);

create table types.byteas (id int primary key, b bytea);
insert into types.byteas values (1, '\xdeadbeef'), (2, ''), (3, null);

analyze;
