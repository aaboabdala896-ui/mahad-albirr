create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  created_by uuid not null,
  target_role text not null default 'all' check (target_role in ('all','parent','teacher')),
  created_at timestamptz not null default now()
);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  teacher_id uuid not null,
  date date not null,
  status text not null check (status in ('present','absent')),
  updated_at timestamptz not null default now(),
  unique(student_id, date)
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, endpoint)
);

create index if not exists announcements_created_at_idx on public.announcements(created_at desc);
create index if not exists attendance_student_date_idx on public.attendance(student_id, date desc);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);

alter table public.announcements disable row level security;
alter table public.attendance disable row level security;
alter table public.push_subscriptions disable row level security;
