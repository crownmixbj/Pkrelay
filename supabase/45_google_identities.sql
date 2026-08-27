-- LOCI — accounts that arrive from Google rather than from the sign-up form.

/*
  Run after 01–44. Re-runnable.

  ⚠ `handle_new_user` reads one key, and Google does not send it.

    02 copies `raw_user_meta_data ->> 'name'` into `profiles.full_name`,
    because that is what this app's own sign-up writes. An OAuth account's
    metadata comes from the provider: Google sends `full_name`, `name`,
    `avatar_url`, `picture` and `email`. Today it happens to send `name` as
    well, so this would have worked by luck — and stopped working the day
    Google changed its claim set, leaving profiles with a blank name and
    nothing anywhere saying why.

    Reading either key is not a workaround. It is the difference between
    depending on a documented field and depending on a coincidence.

  ⚠ The phone stays empty, deliberately.

    There is nothing to put in it. Google does not share a number, and
    inventing a placeholder would be worse than the blank: `guard_application_
    phone` compares a driver applicant's claimed number to the account's, and a
    placeholder would silently become the only number they are allowed to
    claim. The app asks for a real one on first sign-in — see
    `src/app/(auth)/complete-profile.tsx`.
*/

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    /*
      ⚠ `full_name` first: it is the one Google documents.

        `name` is what this app's own sign-up writes, and what Google also
        happens to send today. Preferring the documented key means an OAuth
        account is read correctly on purpose rather than by accident, and an
        email signup still lands on the second branch.
    */
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_user_meta_data ->> 'name', ''),
      ''
    ),
    /*
      No phone from any provider. Left empty rather than guessed — the app
      refuses to go further until a real one is given.
    */
    coalesce(new.raw_user_meta_data ->> 'phone', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

/*
 * ⚠ Anyone who signed in with Google before this ran has a blank name.
 *
 *   `on conflict do nothing` means their profile row exists and is empty, so
 *   re-running the trigger would not touch it. Only rows that are still blank
 *   are filled — an account whose owner has since edited their name must not
 *   have it overwritten by whatever Google had on file.
 */
update public.profiles p
   set full_name = coalesce(
     nullif(u.raw_user_meta_data ->> 'full_name', ''),
     nullif(u.raw_user_meta_data ->> 'name', ''),
     ''
   )
  from auth.users u
 where u.id = p.id
   and coalesce(btrim(p.full_name), '') = ''
   and coalesce(
     nullif(u.raw_user_meta_data ->> 'full_name', ''),
     nullif(u.raw_user_meta_data ->> 'name', '')
   ) is not null;

notify pgrst, 'reload schema';
