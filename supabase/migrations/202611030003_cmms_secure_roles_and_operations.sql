begin;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null,
  role text not null default 'technician' check (role in ('admin', 'technician')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.devices
  add column if not exists purchase_date date not null default current_date;
alter table public.maintenance_orders
  add column if not exists title text not null default '',
  add column if not exists scheduled_date date not null default current_date,
  add column if not exists approved_by text not null default '',
  add column if not exists started_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
alter table public.warehouse_items
  add column if not exists price bigint not null default 0 check (price >= 0),
  add column if not exists is_active boolean not null default true;
alter table public.activity_logs
  add column if not exists maintenance_order_id uuid references public.maintenance_orders(id) on delete set null;

update public.maintenance_orders
set title = coalesce(nullif(title, ''), nullif(description, ''), order_code)
where title = '';

alter table public.maintenance_orders
  drop constraint if exists maintenance_orders_device_id_fkey;
alter table public.maintenance_orders
  add constraint maintenance_orders_device_id_fkey
  foreign key (device_id) references public.devices(id) on delete restrict;

create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  maintenance_order_id uuid not null references public.maintenance_orders(id) on delete cascade,
  warehouse_item_id uuid not null references public.warehouse_items(id) on delete restrict,
  item_code text not null,
  item_name text not null,
  staff text not null,
  quantity integer not null check (quantity > 0),
  unit_price bigint not null check (unit_price >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  warehouse_item_id uuid not null references public.warehouse_items(id) on delete restrict,
  maintenance_order_id uuid references public.maintenance_orders(id) on delete set null,
  movement_type text not null check (movement_type in ('opening', 'receipt', 'issue', 'return', 'adjustment')),
  delta integer not null,
  quantity_before integer not null check (quantity_before >= 0),
  quantity_after integer not null check (quantity_after >= 0),
  unit_price bigint not null check (unit_price >= 0),
  note text not null,
  performed_by text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists maintenance_orders_date_idx
  on public.maintenance_orders(scheduled_date desc, order_code);
create index if not exists materials_order_idx on public.materials(maintenance_order_id, created_at);
create index if not exists activity_logs_order_idx on public.activity_logs(maintenance_order_id, created_at desc);
create index if not exists stock_movements_item_idx on public.stock_movements(warehouse_item_id, created_at desc);
create index if not exists stock_movements_order_idx on public.stock_movements(maintenance_order_id);

create or replace function public.cmms_is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.is_active
  )
$$;

create or replace function public.cmms_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p
  where p.id = (select auth.uid()) and p.is_active
$$;

create or replace function public.cmms_require_active()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.cmms_is_active() then
    raise exception 'Tài khoản không hoạt động hoặc chưa đăng nhập' using errcode = '42501';
  end if;
end
$$;

create or replace function public.cmms_require_admin()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.cmms_require_active();
  if public.cmms_role() <> 'admin' then
    raise exception 'Chỉ quản trị viên được thực hiện thao tác này' using errcode = '42501';
  end if;
end
$$;

create or replace function public.cmms_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end
$$;

drop trigger if exists cmms_auth_user_created on auth.users;
create trigger cmms_auth_user_created
  after insert on auth.users
  for each row execute function public.cmms_auth_user_created();

insert into public.profiles (id, email, full_name)
select u.id, lower(u.email),
  coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), split_part(u.email, '@', 1))
from auth.users u
on conflict (id) do nothing;

create or replace function public.cmms_guard_order_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'Completed' and not (
    current_setting('myxtech.transition', true) = 'on'
    and old.approved_by = ''
    and new.approved_by <> ''
    and new.status = old.status
    and new.completed_at is not distinct from old.completed_at
    and new.started_at is not distinct from old.started_at
  ) then
    raise exception 'Lệnh đã hoàn tất, không thể chỉnh sửa' using errcode = '23514';
  end if;
  if old.status = 'In Progress' and new.device_id is distinct from old.device_id then
    raise exception 'Không thể đổi thiết bị sau khi đã bắt đầu lệnh' using errcode = '23514';
  end if;
  if (new.status is distinct from old.status or new.approved_by is distinct from old.approved_by
      or new.completed_at is distinct from old.completed_at or new.started_at is distinct from old.started_at)
     and current_setting('myxtech.transition', true) is distinct from 'on' then
    raise exception 'Trạng thái và phê duyệt chỉ được đổi qua nghiệp vụ CMMS' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists cmms_guard_order_transition on public.maintenance_orders;
create trigger cmms_guard_order_transition
  before update on public.maintenance_orders
  for each row execute function public.cmms_guard_order_transition();

create or replace function public.cmms_record_stock_movement(
  p_item_id uuid,
  p_delta integer,
  p_type text,
  p_note text,
  p_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.warehouse_items%rowtype;
  v_after integer;
  v_user text;
begin
  perform public.cmms_require_admin();
  if p_type not in ('receipt', 'adjustment') or p_delta = 0 or length(trim(p_note)) = 0 then
    raise exception 'Giao dịch kho không hợp lệ' using errcode = '22023';
  end if;
  if p_type = 'receipt' and p_delta < 0 then
    raise exception 'Số lượng nhập kho phải lớn hơn 0' using errcode = '22023';
  end if;
  select * into v_item from public.warehouse_items where id = p_item_id and is_active for update;
  if not found then raise exception 'Không tìm thấy vật tư đang hoạt động' using errcode = 'P0002'; end if;
  v_after := v_item.stock_quantity + p_delta;
  if v_after < 0 then raise exception 'Tồn kho không đủ' using errcode = '23514'; end if;
  update public.warehouse_items set stock_quantity = v_after, updated_at = now() where id = v_item.id;
  select p.full_name into v_user from public.profiles p where p.id = auth.uid();
  insert into public.stock_movements
    (warehouse_item_id, maintenance_order_id, movement_type, delta, quantity_before,
     quantity_after, unit_price, note, performed_by)
  values (v_item.id, p_order_id, p_type, p_delta, v_item.stock_quantity, v_after,
    v_item.price, trim(p_note), coalesce(v_user, ''));
  return jsonb_build_object('qtyBefore', v_item.stock_quantity, 'qtyAfter', v_after,
    'delta', p_delta, 'unitPrice', v_item.price);
end
$$;

create or replace function public.cmms_create_warehouse_item(p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.warehouse_items%rowtype;
  v_qty integer;
  v_min integer;
  v_price bigint;
  v_user text;
begin
  perform public.cmms_require_admin();
  v_qty := coalesce((p_item ->> 'qty')::integer, 0);
  v_min := coalesce((p_item ->> 'min')::integer, 0);
  v_price := coalesce((p_item ->> 'price')::bigint, 0);
  if v_qty < 0 or v_min < 0 or v_price < 0
    or length(trim(coalesce(p_item ->> 'code', ''))) = 0
    or length(trim(coalesce(p_item ->> 'name', ''))) = 0
    or length(trim(coalesce(p_item ->> 'unit', ''))) = 0 then
    raise exception 'Thông tin vật tư không hợp lệ' using errcode = '22023';
  end if;
  insert into public.warehouse_items (item_code, name, unit, category, stock_quantity, min_stock_level, price)
  values (trim(p_item ->> 'code'), trim(p_item ->> 'name'), trim(p_item ->> 'unit'), '',
    0, v_min, v_price)
  returning * into v_item;
  if v_qty > 0 then
    select p.full_name into v_user from public.profiles p where p.id = auth.uid();
    update public.warehouse_items set stock_quantity = v_qty, updated_at = now() where id = v_item.id;
    insert into public.stock_movements
      (warehouse_item_id, movement_type, delta, quantity_before, quantity_after, unit_price, note, performed_by)
    values (v_item.id, 'opening', v_qty, 0, v_qty, v_price, 'Nhập tồn ban đầu.', coalesce(v_user, ''));
  end if;
  return jsonb_build_object('id', v_item.id, 'item_code', v_item.item_code, 'name', v_item.name,
    'unit', v_item.unit, 'stock_quantity', v_qty, 'min_stock_level', v_item.min_stock_level,
    'price', v_item.price, 'is_active', true);
end
$$;

create or replace function public.cmms_deactivate_warehouse_item(p_item_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.warehouse_items%rowtype;
begin
  perform public.cmms_require_admin();
  select * into v_item from public.warehouse_items
    where item_code = p_item_code and is_active for update;
  if not found then raise exception 'Không tìm thấy vật tư đang hoạt động' using errcode = 'P0002'; end if;
  if v_item.stock_quantity <> 0 then
    raise exception 'Chỉ có thể ngừng sử dụng vật tư khi tồn kho bằng 0' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.materials m
    join public.maintenance_orders o on o.id = m.maintenance_order_id
    where m.warehouse_item_id = v_item.id and o.status = 'In Progress'
  ) then
    raise exception 'Vật tư đang được dùng trong lệnh chưa hoàn thành' using errcode = '23514';
  end if;
  update public.warehouse_items set is_active = false, updated_at = now() where id = v_item.id;
end
$$;

create or replace function public.cmms_issue_material(
  p_order_code text,
  p_item_code text,
  p_quantity integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.maintenance_orders%rowtype;
  v_item public.warehouse_items%rowtype;
  v_user public.profiles%rowtype;
  v_after integer;
  v_material public.materials%rowtype;
begin
  perform public.cmms_require_active();
  if p_quantity <= 0 then raise exception 'Số lượng phải lớn hơn 0' using errcode = '22023'; end if;
  select * into v_order from public.maintenance_orders where order_code = p_order_code for update;
  if not found then raise exception 'Không tìm thấy lệnh bảo trì' using errcode = 'P0002'; end if;
  if v_order.status <> 'In Progress' or v_order.approved_by <> '' then
    raise exception 'Chỉ được xuất vật tư cho lệnh đang thực hiện' using errcode = '23514';
  end if;
  select * into v_item from public.warehouse_items
    where item_code = p_item_code and is_active for update;
  if not found then raise exception 'Không tìm thấy vật tư đang hoạt động' using errcode = 'P0002'; end if;
  v_after := v_item.stock_quantity - p_quantity;
  if v_after < 0 then raise exception 'Tồn kho không đủ' using errcode = '23514'; end if;
  select * into v_user from public.profiles where id = auth.uid();
  update public.warehouse_items set stock_quantity = v_after, updated_at = now() where id = v_item.id;
  insert into public.materials
    (maintenance_order_id, warehouse_item_id, item_code, item_name, staff, quantity, unit_price)
  values (v_order.id, v_item.id, v_item.item_code, v_item.name, v_user.full_name, p_quantity, v_item.price)
  returning * into v_material;
  insert into public.stock_movements
    (warehouse_item_id, maintenance_order_id, movement_type, delta, quantity_before,
      quantity_after, unit_price, note, performed_by)
  values (v_item.id, v_order.id, 'issue', -p_quantity, v_item.stock_quantity, v_after,
    v_item.price, 'Xuất dùng cho lệnh ' || p_order_code, v_user.full_name);
  insert into public.activity_logs (device_id, maintenance_order_id, event_type, details, created_by)
  values (v_order.device_id, v_order.id, 'material_issued',
    'Xuất ' || p_quantity || ' ' || v_item.unit || ' ' || v_item.name || '.', v_user.full_name);
  return jsonb_build_object('id', v_material.id, 'workCode', v_order.order_code, 'code', v_item.item_code,
    'name', v_item.name, 'staff', v_user.full_name, 'qty', p_quantity, 'price', v_item.price,
    'addedAt', v_material.created_at);
end
$$;

create or replace function public.cmms_return_material(p_material_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_material public.materials%rowtype;
  v_order public.maintenance_orders%rowtype;
  v_item public.warehouse_items%rowtype;
  v_user public.profiles%rowtype;
  v_after integer;
begin
  perform public.cmms_require_active();
  select * into v_material from public.materials where id = p_material_id for update;
  if not found then raise exception 'Không tìm thấy vật tư đã cấp' using errcode = 'P0002'; end if;
  select * into v_order from public.maintenance_orders where id = v_material.maintenance_order_id for update;
  if v_order.status <> 'In Progress' or v_order.approved_by <> '' then
    raise exception 'Không thể hoàn trả vật tư cho lệnh đã kết thúc' using errcode = '23514';
  end if;
  select * into v_item from public.warehouse_items where id = v_material.warehouse_item_id for update;
  v_after := v_item.stock_quantity + v_material.quantity;
  select * into v_user from public.profiles where id = auth.uid();
  update public.warehouse_items set stock_quantity = v_after, updated_at = now() where id = v_item.id;
  insert into public.stock_movements
    (warehouse_item_id, maintenance_order_id, movement_type, delta, quantity_before,
      quantity_after, unit_price, note, performed_by)
  values (v_item.id, v_order.id, 'return', v_material.quantity, v_item.stock_quantity, v_after,
    v_material.unit_price, 'Hoàn trả vật tư của lệnh ' || v_order.order_code, v_user.full_name);
  insert into public.activity_logs (device_id, maintenance_order_id, event_type, details, created_by)
  values (v_order.device_id, v_order.id, 'material_returned',
    'Hoàn trả ' || v_material.quantity || ' ' || v_item.unit || ' ' || v_item.name || '.', v_user.full_name);
  delete from public.materials where id = v_material.id;
end
$$;

create or replace function public.cmms_transition_work(p_order_code text, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.maintenance_orders%rowtype;
  v_device public.devices%rowtype;
  v_user public.profiles%rowtype;
  v_next_status text;
  v_event text;
begin
  perform public.cmms_require_active();
  if p_action = 'approve' then perform public.cmms_require_admin(); end if;
  select * into v_order from public.maintenance_orders where order_code = p_order_code for update;
  if not found then raise exception 'Không tìm thấy lệnh bảo trì' using errcode = 'P0002'; end if;
  select * into v_user from public.profiles where id = auth.uid();
  perform set_config('myxtech.transition', 'on', true);
  if p_action = 'start' then
    if v_order.status <> 'Pending' then raise exception 'Chỉ bắt đầu được lệnh đang chờ' using errcode = '23514'; end if;
    if v_order.device_id is null then raise exception 'Lệnh chưa liên kết thiết bị' using errcode = '23514'; end if;
    if exists (select 1 from public.maintenance_orders other_order
      where other_order.device_id = v_order.device_id and other_order.status = 'In Progress'
        and other_order.id <> v_order.id) then
      raise exception 'Thiết bị đang có lệnh bảo trì khác' using errcode = '23514';
    end if;
    v_next_status := 'In Progress';
    v_event := 'started';
    update public.maintenance_orders set status = v_next_status, started_at = coalesce(started_at, now())
      where id = v_order.id;
    update public.devices set status = 'Maintenance' where id = v_order.device_id and status = 'Active';
  elsif p_action = 'complete' then
    if v_order.status <> 'In Progress' then raise exception 'Chỉ hoàn thành được lệnh đang thực hiện' using errcode = '23514'; end if;
    v_next_status := 'Completed';
    v_event := 'completed';
    update public.maintenance_orders set status = v_next_status, completed_at = now() where id = v_order.id;
    if v_order.device_id is not null and not exists (
      select 1 from public.maintenance_orders other_order
      where other_order.device_id = v_order.device_id and other_order.status = 'In Progress'
        and other_order.id <> v_order.id
    ) then
      update public.devices set status = 'Active'
        where id = v_order.device_id and status = 'Maintenance';
    end if;
  elsif p_action = 'approve' then
    if v_order.status <> 'Completed' or v_order.approved_by <> '' then
      raise exception 'Chỉ phê duyệt được lệnh hoàn tất chưa duyệt' using errcode = '23514';
    end if;
    v_next_status := v_order.status;
    v_event := 'approved';
    update public.maintenance_orders set approved_by = v_user.full_name where id = v_order.id;
  else
    raise exception 'Thao tác lệnh không hợp lệ' using errcode = '22023';
  end if;
  insert into public.activity_logs (device_id, maintenance_order_id, event_type, details, created_by)
  values (v_order.device_id, v_order.id, v_event,
    case p_action when 'start' then 'Bắt đầu thực hiện lệnh bảo trì.'
      when 'complete' then 'Đã đánh dấu hoàn thành, chờ phê duyệt.'
      else 'Lệnh bảo trì đã được quản trị viên phê duyệt.' end,
    v_user.full_name);
  return jsonb_build_object('order_code', v_order.order_code, 'status', v_next_status,
    'approved_by', case when p_action = 'approve' then v_user.full_name else v_order.approved_by end);
end
$$;

create or replace function public.cmms_report_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform public.cmms_require_active();
  select jsonb_build_object(
    'itemCount', (select count(*) from public.warehouse_items where is_active),
    'lowStockCount', (select count(*) from public.warehouse_items where is_active and stock_quantity <= min_stock_level),
    'inventoryValue', (select coalesce(sum(stock_quantity::bigint * price), 0) from public.warehouse_items where is_active),
    'overdueCount', (select count(*) from public.maintenance_orders where status = 'Pending' and scheduled_date < current_date),
    'activeCount', (select count(*) from public.maintenance_orders where status = 'In Progress'),
    'issuedCost', (select coalesce(sum(-delta::bigint * unit_price), 0) from public.stock_movements where movement_type in ('issue', 'return'))
  ) into v_result;
  return v_result;
end
$$;

create or replace function public.cmms_add_work_event(p_order_code text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.maintenance_orders%rowtype;
  v_user public.profiles%rowtype;
  v_event public.activity_logs%rowtype;
begin
  perform public.cmms_require_active();
  if length(trim(p_note)) = 0 or length(p_note) > 2000 then
    raise exception 'Ghi chú không hợp lệ' using errcode = '22023';
  end if;
  select * into v_order from public.maintenance_orders where order_code = p_order_code for update;
  if not found then raise exception 'Không tìm thấy lệnh bảo trì' using errcode = 'P0002'; end if;
  if v_order.status = 'Completed' or v_order.approved_by <> '' then
    raise exception 'Lệnh đã hoàn tất, không thể thêm ghi chú' using errcode = '23514';
  end if;
  select * into v_user from public.profiles where id = auth.uid();
  insert into public.activity_logs (device_id, maintenance_order_id, event_type, details, created_by)
  values (v_order.device_id, v_order.id, 'note', trim(p_note), v_user.full_name)
  returning * into v_event;
  return jsonb_build_object('id', v_event.id, 'eventType', v_event.event_type,
    'note', v_event.details, 'actor', v_event.created_by, 'createdAt', v_event.created_at);
end
$$;

create or replace function public.cmms_delete_work(p_order_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
begin
  perform public.cmms_require_admin();
  select id into v_order_id from public.maintenance_orders where order_code = p_order_code for update;
  if v_order_id is null then raise exception 'Không tìm thấy lệnh bảo trì' using errcode = 'P0002'; end if;
  if exists (select 1 from public.stock_movements where maintenance_order_id = v_order_id) then
    raise exception 'Không thể xóa lệnh có giao dịch kho; hãy giữ lại lịch sử bảo trì' using errcode = '23514';
  end if;
  delete from public.maintenance_orders where id = v_order_id;
end
$$;

create or replace function public.cmms_set_user_status(p_user_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.profiles%rowtype;
  v_admin_count integer;
begin
  perform public.cmms_require_admin();
  if p_user_id = auth.uid() then raise exception 'Không thể tự thay đổi trạng thái tài khoản' using errcode = '23514'; end if;
  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then raise exception 'Không tìm thấy tài khoản' using errcode = 'P0002'; end if;
  if v_target.role = 'admin' and v_target.is_active and not p_is_active then
    select count(*) into v_admin_count from public.profiles where role = 'admin' and is_active;
    if v_admin_count <= 1 then raise exception 'Không thể vô hiệu hóa quản trị viên cuối cùng' using errcode = '23514'; end if;
  end if;
  update public.profiles set is_active = p_is_active where id = p_user_id;
end
$$;

create or replace function public.cmms_import_local_data(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform public.cmms_require_admin();
  if p_data is null or jsonb_typeof(p_data) <> 'object'
    or jsonb_typeof(coalesce(p_data -> 'items', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_data -> 'works', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_data -> 'warehouse', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_data -> 'materials', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_data -> 'workEvents', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_data -> 'stockMovements', '[]'::jsonb)) <> 'array' then
    raise exception 'Tệp nhập CMMS không đúng cấu trúc' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_data -> 'items', '[]'::jsonb)) > 5000
    or jsonb_array_length(coalesce(p_data -> 'works', '[]'::jsonb)) > 10000
    or jsonb_array_length(coalesce(p_data -> 'warehouse', '[]'::jsonb)) > 10000
    or jsonb_array_length(coalesce(p_data -> 'materials', '[]'::jsonb)) > 50000
    or jsonb_array_length(coalesce(p_data -> 'workEvents', '[]'::jsonb)) > 50000
    or jsonb_array_length(coalesce(p_data -> 'stockMovements', '[]'::jsonb)) > 50000 then
    raise exception 'Tệp nhập vượt quá giới hạn số bản ghi' using errcode = '22023';
  end if;
  if exists (select 1 from public.devices)
    or exists (select 1 from public.maintenance_orders)
    or exists (select 1 from public.warehouse_items)
    or exists (select 1 from public.materials)
    or exists (select 1 from public.activity_logs)
    or exists (select 1 from public.stock_movements) then
    raise exception 'Các bảng CMMS đích không trống; dừng để tránh ghi đè dữ liệu' using errcode = '23505';
  end if;

  insert into public.devices (asset_code, name, location, purchase_date, status)
  select i.code, i.name, i.location, nullif(i.date, '')::date,
    case i.status when 'active' then 'Active' when 'maintenance' then 'Maintenance' else 'Inactive' end
  from jsonb_to_recordset(coalesce(p_data -> 'items', '[]'::jsonb))
    as i(code text, name text, location text, date text, status text);

  insert into public.warehouse_items (item_code, name, unit, stock_quantity, min_stock_level, price, is_active)
  select w.code, w.name, w.unit, w.qty, w.min, w.price, w.is_active <> 0
  from jsonb_to_recordset(coalesce(p_data -> 'warehouse', '[]'::jsonb))
    as w(code text, name text, unit text, qty integer, min integer, price bigint, is_active integer);

  insert into public.maintenance_orders
    (order_code, title, description, scheduled_date, device_id, status, priority, maintenance_type,
     assigned_to, approved_by, started_at, completed_at)
  select w.code, w.name, coalesce(w.description, w.name), nullif(w.date, '')::date,
    d.id,
    case when w.status = 'inprogress' then 'In Progress'
      when w.status = 'terminated' then 'Completed' else 'Pending' end,
    case when w.status = 'priority' or w.priority = 'high' then 'High' else 'Normal' end,
    case w."maintenanceType" when 'corrective' then 'Corrective' when 'inspection' then 'Inspection' else 'Preventative' end,
    coalesce(w.assignee, ''), coalesce(w."approvedBy", ''), nullif(w."startedAt", '')::timestamptz,
    nullif(w."completedAt", '')::timestamptz
  from jsonb_to_recordset(coalesce(p_data -> 'works', '[]'::jsonb))
    as w(code text, name text, description text, date text, equip text, status text, priority text,
      "maintenanceType" text, assignee text, "approvedBy" text, "startedAt" text, "completedAt" text, "assetCode" text)
  left join public.devices d on d.asset_code = nullif(w."assetCode", '');

  insert into public.materials
    (maintenance_order_id, warehouse_item_id, item_code, item_name, staff, quantity, unit_price, created_at)
  select o.id, wi.id, m.code, m.name, m.staff, m.qty, m.price, coalesce(nullif(m."addedAt", '')::timestamptz, now())
  from jsonb_to_recordset(coalesce(p_data -> 'materials', '[]'::jsonb))
    as m("workCode" text, code text, name text, staff text, qty integer, price bigint, "addedAt" text)
  join public.maintenance_orders o on o.order_code = m."workCode"
  join public.warehouse_items wi on wi.item_code = m.code;

  insert into public.activity_logs
    (device_id, maintenance_order_id, event_type, details, created_by, created_at)
  select o.device_id, o.id, e."eventType", coalesce(e.note, ''), coalesce(e.actor, ''),
    coalesce(nullif(e."createdAt", '')::timestamptz, now())
  from jsonb_to_recordset(coalesce(p_data -> 'workEvents', '[]'::jsonb))
    as e("workCode" text, "eventType" text, note text, actor text, "createdAt" text)
  join public.maintenance_orders o on o.order_code = e."workCode";

  insert into public.stock_movements
    (warehouse_item_id, maintenance_order_id, movement_type, delta, quantity_before,
     quantity_after, unit_price, note, performed_by, created_at)
  select wi.id, o.id,
    case m."movementType" when 'migration' then 'adjustment' else m."movementType" end,
    m.delta, m."qtyBefore", m."qtyAfter", m."unitPrice", m.note, coalesce(m."performedBy", ''),
    coalesce(nullif(m."createdAt", '')::timestamptz, now())
  from jsonb_to_recordset(coalesce(p_data -> 'stockMovements', '[]'::jsonb))
    as m("warehouseCode" text, "workCode" text, "movementType" text, delta integer, "qtyBefore" integer,
      "qtyAfter" integer, "unitPrice" bigint, note text, "performedBy" text, "createdAt" text)
  join public.warehouse_items wi on wi.item_code = m."warehouseCode"
  left join public.maintenance_orders o on o.order_code = nullif(m."workCode", '');

  if (select count(*) from public.devices) <> jsonb_array_length(coalesce(p_data -> 'items', '[]'::jsonb))
    or (select count(*) from public.maintenance_orders) <> jsonb_array_length(coalesce(p_data -> 'works', '[]'::jsonb))
    or (select count(*) from public.warehouse_items) <> jsonb_array_length(coalesce(p_data -> 'warehouse', '[]'::jsonb))
    or (select count(*) from public.materials) <> jsonb_array_length(coalesce(p_data -> 'materials', '[]'::jsonb))
    or (select count(*) from public.activity_logs) <> jsonb_array_length(coalesce(p_data -> 'workEvents', '[]'::jsonb))
    or (select count(*) from public.stock_movements) <> jsonb_array_length(coalesce(p_data -> 'stockMovements', '[]'::jsonb)) then
    raise exception 'Một số bản ghi nhập không liên kết được; toàn bộ giao dịch đã bị hủy' using errcode = '23503';
  end if;

  v_result := jsonb_build_object(
    'items', jsonb_array_length(coalesce(p_data -> 'items', '[]'::jsonb)),
    'works', jsonb_array_length(coalesce(p_data -> 'works', '[]'::jsonb)),
    'warehouse', jsonb_array_length(coalesce(p_data -> 'warehouse', '[]'::jsonb)),
    'materials', jsonb_array_length(coalesce(p_data -> 'materials', '[]'::jsonb)),
    'workEvents', jsonb_array_length(coalesce(p_data -> 'workEvents', '[]'::jsonb)),
    'stockMovements', jsonb_array_length(coalesce(p_data -> 'stockMovements', '[]'::jsonb))
  );
  return v_result;
end
$$;

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.maintenance_orders enable row level security;
alter table public.warehouse_items enable row level security;
alter table public.activity_logs enable row level security;
alter table public.materials enable row level security;
alter table public.stock_movements enable row level security;

drop policy if exists "active users read profiles" on public.profiles;
create policy "active users read profiles" on public.profiles for select to authenticated
  using (public.cmms_is_active() and (id = (select auth.uid()) or public.cmms_role() = 'admin'));
drop policy if exists "active users read devices" on public.devices;
create policy "active users read devices" on public.devices for select to authenticated
  using (public.cmms_is_active());
drop policy if exists "admins manage devices" on public.devices;
create policy "admins manage devices" on public.devices for all to authenticated
  using (public.cmms_role() = 'admin') with check (public.cmms_role() = 'admin');
drop policy if exists "active users read maintenance orders" on public.maintenance_orders;
create policy "active users read maintenance orders" on public.maintenance_orders for select to authenticated
  using (public.cmms_is_active());
drop policy if exists "active users create maintenance orders" on public.maintenance_orders;
create policy "active users create maintenance orders" on public.maintenance_orders for insert to authenticated
  with check (public.cmms_is_active() and status = 'Pending' and approved_by = '' and completed_at is null);
drop policy if exists "active users update maintenance order details" on public.maintenance_orders;
create policy "active users update maintenance order details" on public.maintenance_orders for update to authenticated
  using (public.cmms_is_active() and approved_by = '')
  with check (public.cmms_is_active() and approved_by = '');
drop policy if exists "admins delete maintenance orders" on public.maintenance_orders;
create policy "admins delete maintenance orders" on public.maintenance_orders for delete to authenticated
  using (public.cmms_role() = 'admin');
drop policy if exists "active users read warehouse items" on public.warehouse_items;
create policy "active users read warehouse items" on public.warehouse_items for select to authenticated
  using (public.cmms_is_active());
drop policy if exists "admins manage warehouse items" on public.warehouse_items;
create policy "admins manage warehouse items" on public.warehouse_items for all to authenticated
  using (public.cmms_role() = 'admin') with check (public.cmms_role() = 'admin');
drop policy if exists "active users read activity logs" on public.activity_logs;
create policy "active users read activity logs" on public.activity_logs for select to authenticated
  using (public.cmms_is_active());
drop policy if exists "active users read materials" on public.materials;
create policy "active users read materials" on public.materials for select to authenticated
  using (public.cmms_is_active());
drop policy if exists "active users read stock movements" on public.stock_movements;
create policy "active users read stock movements" on public.stock_movements for select to authenticated
  using (public.cmms_is_active());

revoke all privileges on public.profiles, public.devices, public.maintenance_orders,
  public.warehouse_items, public.activity_logs, public.materials, public.stock_movements
from public, anon, authenticated;

grant select on public.profiles, public.devices, public.maintenance_orders,
  public.warehouse_items, public.activity_logs, public.materials, public.stock_movements
to authenticated;
grant insert (asset_code, name, category, location, status, qr_code, purchase_date),
  update (name, category, location, status, qr_code, purchase_date), delete
  on public.devices to authenticated;
grant insert (item_code, name, category, unit, min_stock_level, price, is_active),
  update (name, category, unit, min_stock_level, price, is_active)
  on public.warehouse_items to authenticated;
grant insert (order_code, title, description, scheduled_date, device_id,
  maintenance_type, priority, assigned_to) on public.maintenance_orders to authenticated;
grant update (title, maintenance_type, priority, description, assigned_to, scheduled_date, device_id)
  on public.maintenance_orders to authenticated;

revoke all on function public.cmms_is_active() from public, anon;
revoke all on function public.cmms_role() from public, anon;
revoke all on function public.cmms_require_active() from public, anon, authenticated;
revoke all on function public.cmms_require_admin() from public, anon, authenticated;
revoke all on function public.cmms_auth_user_created() from public, anon, authenticated;
revoke all on function public.cmms_guard_order_transition() from public, anon, authenticated;
revoke all on function public.cmms_record_stock_movement(uuid, integer, text, text, uuid) from public, anon;
revoke all on function public.cmms_create_warehouse_item(jsonb) from public, anon;
revoke all on function public.cmms_deactivate_warehouse_item(text) from public, anon;
revoke all on function public.cmms_issue_material(text, text, integer) from public, anon;
revoke all on function public.cmms_return_material(uuid) from public, anon;
revoke all on function public.cmms_transition_work(text, text) from public, anon;
revoke all on function public.cmms_report_summary() from public, anon;
revoke all on function public.cmms_add_work_event(text, text) from public, anon;
revoke all on function public.cmms_delete_work(text) from public, anon;
revoke all on function public.cmms_set_user_status(uuid, boolean) from public, anon;
revoke all on function public.cmms_import_local_data(jsonb) from public, anon;
grant execute on function public.cmms_is_active() to authenticated;
grant execute on function public.cmms_role() to authenticated;
grant execute on function public.cmms_record_stock_movement(uuid, integer, text, text, uuid) to authenticated;
grant execute on function public.cmms_create_warehouse_item(jsonb) to authenticated;
grant execute on function public.cmms_deactivate_warehouse_item(text) to authenticated;
grant execute on function public.cmms_issue_material(text, text, integer) to authenticated;
grant execute on function public.cmms_return_material(uuid) to authenticated;
grant execute on function public.cmms_transition_work(text, text) to authenticated;
grant execute on function public.cmms_report_summary() to authenticated;
grant execute on function public.cmms_add_work_event(text, text) to authenticated;
grant execute on function public.cmms_delete_work(text) to authenticated;
grant execute on function public.cmms_set_user_status(uuid, boolean) to authenticated;
grant execute on function public.cmms_import_local_data(jsonb) to authenticated;

commit;
