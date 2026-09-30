-- =====================================================================
-- Mis Gastos — esquema
-- Correr una sola vez en el SQL editor de Supabase (proyecto ojzcxwhoinmljospgmfp)
-- =====================================================================
--
-- Misma forma que min_estado / seg_estado: app personal, un dueño por fila y
-- un solo escritor, así que todo el estado (movimientos, fijos, categorías,
-- plan de proyección) viaja como un documento JSON.

create table if not exists public.gas_estado (
  user_id     uuid        primary key references auth.users(id) on delete cascade,
  datos       jsonb       not null default '{}'::jsonb,
  version     integer     not null default 1,
  actualizado timestamptz not null default now()
);

comment on table  public.gas_estado is 'Control de gastos personal, un documento por usuario';
comment on column public.gas_estado.version is
  'Se incrementa en cada guardado. La app actualiza con WHERE version = <la que leyó>: si no afecta ninguna fila es porque otro dispositivo guardó primero, y en vez de pisar avisa.';

alter table public.gas_estado enable row level security;

-- Cada uno ve y escribe únicamente su propia fila. Sin política de DELETE.
drop policy if exists gas_estado_select on public.gas_estado;
create policy gas_estado_select on public.gas_estado
  for select using (auth.uid() = user_id);

drop policy if exists gas_estado_insert on public.gas_estado;
create policy gas_estado_insert on public.gas_estado
  for insert with check (auth.uid() = user_id);

drop policy if exists gas_estado_update on public.gas_estado;
create policy gas_estado_update on public.gas_estado
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
