# Avery & Aiden · Our little universe

An English-only family journal with the original cream, orange, lavender, and green homepage. Built with plain HTML, CSS, and JavaScript. Static hosting is sufficient; no build step or local database server is needed.

## What works

- Public welcome page with the original CSS illustrations and What-if machine.
- Journal, photo library, search, author filters, and story dates.
- Text-only, photo-only, or mixed stories; up to 20 photos per story, with ordering and a shared caption.
- Automatic saving for drafts, explicit saving for published edits, and version checks to avoid silently overwriting another tab/device's changes.
- Recoverable trash. Authors manage their own stories; administrators can also move published stories to trash and restore them. Other people's drafts remain private, including from the site's administrator account.
- Responsive layouts, keyboard controls, and accessible form labels/status messages.

There are two clearly labeled storage modes:

| Mode | Storage | Access |
| --- | --- | --- |
| Device demo (available now) | IndexedDB in the current browser | No account; never shared with family |
| Connected family journal | Supabase Auth, PostgreSQL, and a private Storage bucket | Invited, active family members only |

The website is connected to the `avery-aiden` Supabase project in US East. Its database and private photo bucket are installed; live database authorization checks pass. Dashboard Auth settings, email delivery, and the first family account must be completed before family sign-in is ready for use. The steps below also document setup for a replacement project; do not rerun the initial schema on the connected project.

Device stories do not automatically migrate to Supabase. Demo data can disappear when browser data is cleared; do not use the demo as the only copy of important memories.

## Preview locally

From the repository root:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Visit <http://127.0.0.1:8000>, open **Our family journal**, and choose **Try on this device**. Serve over HTTP on localhost or HTTPS on a host; opening `index.html` as a `file://` URL will not load JavaScript modules correctly. Stop the server with Ctrl+C.

## Connect Supabase

### 1. Create the project and database

Create a Supabase project in a US region near your family. Save the database password privately; it does not belong in this website.

In the project's **SQL Editor**, run all of [`supabase/schema.sql`](supabase/schema.sql) **once in a new project**. The transaction creates:

- `family_members`: invited Auth user IDs, display names, roles, active membership.
- `posts`: text, dates, author, draft/published state, versions, recoverable trash.
- `photos`: ordered metadata pointing to compressed images and thumbnails.
- `family-photos`: a **private** JPEG bucket, with a 2 MB per-object limit.
- Row-level security (RLS), membership helpers, and atomic save/trash functions.

The schema is for **one family per project**. It is an initial migration, not a repeatable reset script. Save future schema changes as new migrations. Leave the `private` schema out of the API's exposed schemas.

### 2. Configure invitation-only authentication

In **Authentication** settings:

1. Keep email/password authentication enabled and disable **Allow new users to sign up** (the wording/location may vary in the dashboard).
2. Set **Site URL** to `https://averyaiden.com/`.
3. Add `https://averyaiden.com/` to allowed redirect URLs. During local testing, also add `http://127.0.0.1:8000/`.
4. Configure a custom SMTP provider for invitation and password-reset emails. Supabase's default sender restricts recipients and volume, so do not depend on it for ordinary family invitations.

There is no public registration form. Creating an Auth account alone does not grant journal access: an active `family_members` row is also required.

### 3. Add the owner and family members

Use **Authentication → Users → Invite user** to invite an email address. Then use the SQL Editor to add its membership **before that person uses the journal**. Replace both example values below:

```sql
insert into public.family_members (user_id, display_name, role)
select id, 'Your display name', 'admin'
from auth.users
where email = 'owner@example.com';
```

For every other invited family member, including children with separate accounts, repeat using `'member'` as the role and that person's email/display name. Each account needs its own email address. If zero rows are inserted, check the invited address in the Users list. Membership management intentionally stays in the owner's Supabase dashboard; the browser cannot invite people, change roles, or grant itself access.

The invitation link opens the website's account page to set a password (at least 12 characters). After that, use **Family sign in** with email/password. **Forgot your password?** sends a reset link back to this site. Test invitation and recovery links on the configured production URL.

To revoke someone's access without deleting their stories:

```sql
update public.family_members
set active = false
where user_id = 'the-auth-user-uuid';
```

RLS checks active membership on each server request. Revocation cannot retract photos or text someone has already downloaded or viewed in an open browser.

### 4. Set the public connection values

Copy the project's HTTPS URL and **publishable key** from Supabase's Connect/API settings into [`config.js`](config.js):

```js
export const config = Object.freeze({
  supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
  supabasePublishableKey: 'sb_publishable_YOUR_PUBLIC_KEY',
});
```

These two values are public browser configuration and may be committed. A legacy `anon` key is also supported. **Never put a database password, `service_role` key, or `sb_secret_` key in this repository or browser code.** Security comes from the database/storage policies, not hiding a publishable key.

The Supabase browser client is loaded from jsDelivr at a pinned version (`2.117.3`) only when configuration is present. The device demo does not load it. No environment variable substitution or server-side credentials are needed.

### 5. Verify the connected journal before using real memories

With two invited test accounts and a signed-out window, confirm:

- Signed-out visitors see the homepage and sign-in page, with no private stories or photos.
- Account A can save a draft with photos; B cannot see it. Once A publishes, B can read it and its photos.
- B cannot edit A's story. A can edit, remove/reorder photos, move the story to trash, and restore it.
- A published story in trash is hidden from ordinary other members. An administrator can restore it.
- Revoked accounts cannot fetch new stories or photos. Public bucket URLs cannot retrieve private images.
- The invitation and reset-password emails return to the correct site, and login works after reload.

The automated tests exercise PostgreSQL policies locally, but they do **not** replace this live check of Supabase Auth, Storage, email delivery, and hosting.

## Photo handling and data care

JPEG, PNG, and WebP inputs up to 20 MB are decoded and re-encoded in the browser as JPEGs (long edge up to 2048 px), plus a 400 px thumbnail. Canvas re-encoding discards original EXIF/GPS metadata. HEIC and video are not supported; export HEIC as JPEG first. Originals never leave the browser through this app and should be kept separately.

Cloud photos are downloaded through authenticated Storage requests and shown with temporary blob URLs. There are no public or reusable signed photo URLs. The app clears rendered private content and blob URLs on sign-out. Stories are rendered as plain text; user HTML is not executed.

Story changes and photo metadata are saved atomically with a version check. Uploads happen first; failed saves attempt to clean up unreferenced images, and committed images are protected from direct deletion. Abruptly closing a tab, losing the network, or a failed cleanup can still leave orphaned uploads consuming space. Review them in the Storage dashboard; keep objects referenced by either `photos.path` or `photos.thumbnail_path`. Delete storage files via the Storage dashboard/API, not by deleting rows from `storage.objects`.

Trash has no automatic purge. It continues using storage until the owner deliberately removes the data through administrative tools. Back up the database **and the Storage files separately**; a database backup alone is not a photo backup. No automated backup, import/export, offline cloud editing, real-time sync, comments, or video is included in this version. Use **Refresh** to load another member's new stories. Check current Supabase quotas and billing before adding a large library.

## Development and verification

Node.js 22 or newer is recommended for development tests:

```sh
npm ci
npm run check
npm test
```

The automated tests cover validation, dates/search, persistent demo photos, stale-edit conflicts, and database authorization using PGlite with minimal Auth/Storage stubs. They do not use a real Supabase project or real family data. Setup verification also ran transaction-rolled-back checks on the connected project for draft privacy, family sharing, author ownership, nonmember rejection, and trash/restore. The privileged write implementations live in the unexposed `private` schema, with invoker wrappers in the public API; anonymous execution is explicitly revoked.

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `script.js` | Original public homepage, illustrations, What-if machine |
| `journal.css`, `journal.js` | Journal views, responsive layout, editing, authentication |
| `lib/model.js`, `lib/photos.js` | Validation/filtering and browser photo compression |
| `lib/store.js` | IndexedDB demo and Supabase storage adapters |
| `config.js` | Public connection settings |
| `supabase/schema.sql` | Initial database/storage schema and access policies |

## Hosting

For GitHub Pages, deploy from the `main` branch and repository root. Keep `CNAME` for the existing custom domain. Publish the HTML/CSS/JavaScript files and `lib/` directory; no build output is needed. All private routes use `#` fragments, so direct links work without server rewrite rules. Use HTTPS on the public domain.

Google Fonts is optional; local fallback fonts keep the page usable if it cannot load. This site has no analytics. Private family content belongs in Supabase, never in this Git repository.

Setup references: [Supabase user data and RLS](https://supabase.com/docs/guides/auth/managing-user-data), [Storage access control](https://supabase.com/docs/guides/storage/security/access-control), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp).
