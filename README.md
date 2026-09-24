# career-watcher

Hourly check of ~110 companies' job boards, filtered to matching titles, deduped
against Postgres, with a Telegram ping only for genuinely new postings.

## Hosting: skip Cloudflare for this piece

Cloudflare Workers are stateless edge functions — they don't hold a normal
long-lived TCP connection to Postgres without extra paid add-ons (Hyperdrive),
so they're a bad fit for "run a script every hour, talk to a database" jobs.
Fastest path that needs zero server management:

- **Postgres:** [Neon](https://neon.tech) or [Supabase](https://supabase.com) —
  free tier, gives you a `DATABASE_URL` connection string in under a minute.
- **The hourly cron:** GitHub Actions (`.github/workflows/hourly.yml`, already
  included). Free for a public or personal repo, runs on schedule with no
  server to keep alive, and your laptop being off doesn't matter.

## Setup

```bash
npm install
cp .env.example .env    # fill in DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
psql "$DATABASE_URL" -f db/schema.sql
npm run seed             # loads db/companies.json into the companies table
node run.js               # run once manually to test
```

For GitHub Actions to run it hourly, add the same three values as repo secrets:
**Settings → Secrets and variables → Actions → New repository secret.**

## Filling in identifiers

`db/companies.json` has all 110 companies pre-classified by ATS type, but
`ats_identifier` is `null` for every one — the code has no way to know a
company's exact board token/slug without you looking it up. This part can't
be skipped safely: guessing wrong would either silently return nothing or,
worse, another company's jobs.

**55 companies** use one of 6 systems with a clean public API — these just
need a short identifier filled in:

| ats_type | identifier shape | how to find it |
|---|---|---|
| `greenhouse` | `"boardtoken"` | careers page → Network tab → request to `boards-api.greenhouse.io/v1/boards/<token>/jobs` |
| `lever` | `"slug"` | same, look for `api.lever.co/v0/postings/<slug>` |
| `ashby` | `"jobBoardName"` | same, look for `api.ashbyhq.com/posting-api/job-board/<name>` |
| `smartrecruiters` | `"companyIdentifier"` | same, look for `api.smartrecruiters.com/v1/companies/<id>/postings` |
| `personio` | `"subdomain"` | the `xxx` in `xxx.jobs.personio.de` |
| `workday` | `{"host":"wd1","tenant":"...","site":"..."}` | same, look for a POST to `<tenant>.<host>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs` |

Once you have a value, update it directly in the DB, e.g.:

```sql
UPDATE companies SET ats_identifier = '"stripe"'::jsonb, active = true
WHERE name = 'Stripe';
```

(For Workday, use the JSON object form, e.g. `'{"host":"wd1","tenant":"adobe","site":"external_experience"}'::jsonb`.)

**The other 55** (Amazon, Google, Meta, Flipkart, Zomato, Swiggy, etc.) have
proprietary career sites — `adapters/custom.js` is a placeholder for these.
They're seeded as `active: false` so `run.js` skips them until you write a
real adapter for each. Do these in priority order (your actual target list,
not all 55 at once) — each one is its own small reverse-engineering job.

## Tuning matches

`lib/keywords.js` controls which titles count as a match — same
include/exclude idea as your Gemini pipeline (reject senior/lead/staff
titles, require a relevant keyword). Edit freely.
