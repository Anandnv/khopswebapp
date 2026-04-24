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




# 🏥 KH Operations Dashboard – Feature List

## 🔐 1. Secure Login & Access Control
Dual login system:
Admin login
Centre login
Centre users can access only their own data
Admin has full network visibility
Password security using SHA-256 encryption
Session persistence (no need to login again on refresh)
Brute-force protection:
Max attempts limit
Temporary login lockout

## 🏢 2. Multi-Centre Management
Multiple centres supported (Tirur, Calicut, Kochi, etc.)
Admin can:
Add new centres
Remove centres
Update usernames & passwords
Each centre has:
Individual targets
Independent daily data tracking

## 📊 3. Consolidated Dashboard (Admin View)
Real-time network-level overview:
Total interventions
CAG totals
Monthly targets
Achievement %
Centre-wise performance table:
Till yesterday
Today
Total
Target vs achievement
Color-coded performance indicators:
🟢 Good (80–100%)
🟡 Watch (40–79%)
🔴 Risk (<40%)

## 🚨 4. Daily Update Monitoring (NEW – HIGH VALUE)
Shows which centres have updated data today
Displays:
✔ Updated
❌ Missing
Top alert box:
“X centres pending today”
Helps admin ensure daily discipline across centres
## 🧾 5. Daily Data Entry System (Centre Users)
Centres can enter:
OP data
IP data
Diagnostics (ECG, Echo, TMT)
Procedure counts
Referral data
System auto-calculates:
Till yesterday
Totals
Entry is date-specific

## 🔒 6. Smart Date Lock System (Critical Feature)
Past dates are automatically locked
Centres cannot edit old data directly
Prevents data manipulation

## 🔓 7. Edit Request & Approval Workflow
Centres can:
Request edit access for past dates
Provide reason for change
Admin can:
Approve or reject requests
Grant time-based access (30 min / 1 hr / 4 hr)
Features:
Pending request tracking
Approval status (Pending / Approved / Rejected / Expired)
Auto-expiry of access

👉 This is a major control feature for data integrity

## ⏱️ 8. Auto Refresh System
Admin panel auto-refreshes:
Edit requests
Status updates
Ensures near real-time monitoring

## 📈 9. Centre-Level Analytics
Drill-down view per centre:
Daily trends (graph)
Today snapshot
Procedure breakdown
Helps identify:
Growth patterns
Daily performance

## 📊 10. OP & Diagnostics Tracking
Tracks:
Total OP
IP
New OP
ECG
Echo
TMT
Available:
Centre-wise
Consolidated

## 🧠 11. Procedure Management System
Admin can:
Add new procedures
Rename procedures
Activate/deactivate procedures
Configure:
Which procedures count as interventions
Which are CAG


## 🎯 12. Target Management
Admin sets monthly targets per centre
System auto-calculates:
Achievement %
Performance vs target

## 📤 13. Advanced Reporting System
Export options:
PDF (presentation-ready)
Excel / CSV
PNG / JPG reports
Filters:
Centre-wise
Date range
Monthly view
Report types:
Consolidated summary
Daily detailed report

## 📉 14. Forecasting & Insights
System calculates:
Average daily interventions
Projected month-end performance
Required daily run rate to hit target
Gives forward-looking insights, not just past data

## 🧮 15. Automated Calculations
No manual totals needed:
Intervention totals
CAG totals
OP totals
Eliminates human calculation errors

## 💾 16. Data Persistence System
Dual storage:
Cloud (Supabase) – primary
Local backup – fallback
Auto-save mechanism
Ensures data safety even during network issues

## 🧾 17. Entry Tracking (Metadata)
Each entry stores:
Last updated time
Centre name
Visible to user:
“Last saved at…”

## 📊 18. Visual Analytics
Bar charts (centre performance)
Trend graphs (daily procedures)
Donut chart (payer split):
General
KASP
MEDISEP

## 📅 19. Month-Based Data Management
Switch between months
Automatic:
Date range adjustment
Data recalculation

## 🔁 20. Intelligent Data Rollups
System dynamically calculates:
Till yesterday
Today
Monthly totals
No need for manual aggregation