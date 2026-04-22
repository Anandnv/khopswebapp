# KH Cardio Ops

Deployable operations dashboard for centre-wise daily entry, consolidated procedure reporting, admin controls, and report exports.

## Run Locally

```powershell
npm.cmd run dev
```

Open the shown local URL.

Prototype logins:

- Admin password: `admin123`
- Centre passwords start as: `1234`

## Data Storage

The app supports two storage modes:

1. Supabase cloud storage, recommended for production.
2. Browser `localStorage`, fallback for local testing only.

If Supabase is configured in `config.js`, data is stored in the Supabase `app_state` table and stays there until you update or delete it.

If Supabase is not configured, data is stored only in that browser's local storage.

## Supabase Setup

1. Create a Supabase project.
2. Open the Supabase SQL editor.
3. Run `supabase/schema.sql`.
4. Open `config.js`.
5. Add your project URL and anon key:

```js
window.KH_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_ID.supabase.co",
  supabaseAnonKey: "YOUR_SUPABASE_ANON_KEY"
};
```

For a stricter production build, replace the simple prototype login with Supabase Auth and role-based database policies.

## Deploy To Vercel

1. Push this folder to GitHub.
2. Go to Vercel and import the repository.
3. Framework preset: `Other`.
4. Build command: `npm run build`.
5. Output directory: leave blank or use `.`.
6. Deploy.

## Deploy To Netlify

1. Push this folder to GitHub.
2. Go to Netlify and import the repository.
3. Build command: `npm run build`.
4. Publish directory: `.`.
5. Deploy.

## Important Production Notes

- `config.js` contains public Supabase anon credentials. That is normal for browser apps, but database policies must be secure before real production use.
- Current app persistence stores the app state as JSON in one row for fast MVP deployment.
- A later production hardening phase should split data into normalized tables: centres, users, procedures, daily entries, procedure counts, targets, and audit logs.
- Enable Supabase backups before using live management data.
