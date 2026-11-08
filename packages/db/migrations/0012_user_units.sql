-- Measurement units for the health tracker. null = follow the browser locale
-- (imperial only for the US, Liberia and Myanmar).
alter table users add column if not exists units text check (units in ('imperial', 'metric'));
