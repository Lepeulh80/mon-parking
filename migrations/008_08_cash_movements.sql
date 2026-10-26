-- Append-only cash movement storage. Financial production writes must use RPCs.
create table if not exists public.cash_movements (
 id uuid primary key default gen_random_uuid(), lot_id uuid not null references public.lots(id),
 session_id uuid not null references public.cash_sessions(id), auth_user_id uuid not null default auth.uid(),
 source text unique, kind text not null check(kind in ('recette','apport','retrait')),
 amount numeric not null check(amount>0), method text not null, reason text,
 created_at timestamptz not null default now()
);
alter table public.cash_movements enable row level security;
revoke all on public.cash_movements from anon,authenticated;
grant select on public.cash_movements to authenticated;
drop policy if exists cash_movements_read on public.cash_movements;
create policy cash_movements_read on public.cash_movements for select to authenticated using(
 public.ops_has_role(lot_id,array['admin','responsable']) or
 (auth_user_id=auth.uid() and public.ops_has_role(lot_id,array['caissier','employe']))
);
-- Direct client INSERT/UPDATE/DELETE deliberately denied. A future transactional
-- RPC must atomically validate session ownership, immutability and the balance.
