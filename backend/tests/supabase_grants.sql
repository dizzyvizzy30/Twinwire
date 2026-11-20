-- Test-only: the table grants Supabase gives its API roles by default. Row Level Security still decides which rows they see.
grant usage on schema public, extensions to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant execute on all functions in schema extensions to authenticated, service_role;
grant execute on function public.person_card(uuid), public.find_people(text, integer), public.ai_spend_today() to authenticated, service_role;
grant execute on function public.answer_event(uuid, text, text[]), public.events_for_me(integer) to authenticated, service_role;
