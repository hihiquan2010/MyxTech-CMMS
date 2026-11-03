begin;

drop policy if exists "Enable all access for public devices" on public.devices;
drop policy if exists "Enable all access for public maintenance_orders" on public.maintenance_orders;
drop policy if exists "Enable all access for public warehouse_items" on public.warehouse_items;
drop policy if exists "Enable all access for public activity_logs" on public.activity_logs;

revoke all privileges on table
  public.devices,
  public.maintenance_orders,
  public.warehouse_items,
  public.activity_logs
from public, anon, authenticated;

commit;
