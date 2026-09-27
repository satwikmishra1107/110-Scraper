import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } },
);

const BATCH_SIZE = 500;

// ---------- Workday facet cache (table: workday_facets) ----------

export async function loadFacetCache() {
  const { data, error } = await supabase.from("workday_facets").select("company, facets");
  if (error) throw new Error(`Supabase facet load failed: ${error.message}`);
  return Object.fromEntries(data.map((row) => [row.company, row.facets]));
}

export async function saveFacet(company, facets) {
  const { error } = await supabase
    .from("workday_facets")
    .upsert({ company, facets, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Supabase facet save failed: ${error.message}`);
}

export async function deleteFacet(company) {
  const { error } = await supabase.from("workday_facets").delete().eq("company", company);
  if (error) throw new Error(`Supabase facet delete failed: ${error.message}`);
}

// ---------- Jobs (table: jobs) ----------

// How many days newer posted_date must be to count as a repost.
// Workday's date is worked out from "Posted Today" with OUR clock (UTC), but Workday counts
// "today" in the company's own time zone. Right after UTC midnight the two disagree by a day,
// so every "Posted Today" job looked 1 day newer. A real repost jumps further than that.
const MIN_REPOST_GAP_DAYS = { workday: 2 };
const DEFAULT_MIN_REPOST_GAP_DAYS = 1;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(olderDate, newerDate) {
  return Math.round((Date.parse(newerDate) - Date.parse(olderDate)) / MILLISECONDS_PER_DAY);
}

// Lookups go per company in small batches: a long `in (...)` list makes the request URL too long.
const LOOKUP_BATCH_SIZE = 50;

// Returns a Map of "company|job_id" → posted_date already stored, for the jobs that exist.
async function loadStoredPostedDates(rows) {
  const jobIdsByCompany = new Map();
  for (const row of rows) {
    if (!jobIdsByCompany.has(row.company)) jobIdsByCompany.set(row.company, []);
    jobIdsByCompany.get(row.company).push(row.job_id);
  }

  const storedPostedDates = new Map();
  for (const [company, jobIds] of jobIdsByCompany) {
    for (let batchStart = 0; batchStart < jobIds.length; batchStart += LOOKUP_BATCH_SIZE) {
      const { data: storedJobs, error } = await supabase
        .from("jobs")
        .select("job_id, posted_date")
        .eq("company", company)
        .in("job_id", jobIds.slice(batchStart, batchStart + LOOKUP_BATCH_SIZE));
      if (error) throw new Error(`Supabase lookup failed: ${error.message}`);
      for (const storedJob of storedJobs) {
        storedPostedDates.set(`${company}|${storedJob.job_id}`, storedJob.posted_date);
      }
    }
  }
  return storedPostedDates;
}

// A reposted job comes back to the board even if you archived it (e.g. because it had closed).
// Only the archived flag changes; your status and note stay. Logs instead of throwing:
// the jobs are already saved by now, so this shouldn't stop the run.
async function unarchiveJobs(updatedJobs) {
  const jobIdsByCompany = new Map();
  for (const updatedJob of updatedJobs) {
    if (!jobIdsByCompany.has(updatedJob.company)) jobIdsByCompany.set(updatedJob.company, []);
    jobIdsByCompany.get(updatedJob.company).push(updatedJob.job_id);
  }

  for (const [company, jobIds] of jobIdsByCompany) {
    for (let batchStart = 0; batchStart < jobIds.length; batchStart += LOOKUP_BATCH_SIZE) {
      const { error } = await supabase
        .from("job_tracking")
        .update({ archived: false })
        .eq("company", company)
        .in("job_id", jobIds.slice(batchStart, batchStart + LOOKUP_BATCH_SIZE));
      if (error) console.error(`Supabase unarchive failed (${company}): ${error.message}`);
    }
  }
}

// Returns brand-new jobs plus updated jobs (is_update: true).
// Updated = same company + job_id already stored, but the ATS now shows a newer posted_date (reposted/edited).
export async function saveJobsAndGetNew(jobs) {
  const unique = [...new Map(jobs.map((job) => [`${job.company}|${job.job_id}`, job])).values()];
  const rows = unique.map(({ scraped_at, ...row }) => row); // scraped_at isn't a column

  const storedPostedDates = await loadStoredPostedDates(rows);
  const rowsToInsert = [];
  const rowsToMarkUpdated = [];
  for (const row of rows) {
    const jobKey = `${row.company}|${row.job_id}`;
    if (!storedPostedDates.has(jobKey)) {
      rowsToInsert.push(row);
      continue;
    }
    const storedPostedDate = storedPostedDates.get(jobKey);
    const minimumGapDays = MIN_REPOST_GAP_DAYS[row.source] ?? DEFAULT_MIN_REPOST_GAP_DAYS;
    if (row.posted_date && storedPostedDate && daysBetween(storedPostedDate, row.posted_date) >= minimumGapDays) {
      // first_seen_at stays as the true first-seen time; reposted_at is what moves it back up the board
      rowsToMarkUpdated.push({ ...row, is_update: true, reposted_at: new Date().toISOString() });
    }
    // otherwise: same job, same date → nothing to do
  }

  const newJobs = [];
  for (let batchStart = 0; batchStart < rowsToInsert.length; batchStart += BATCH_SIZE) {
    const { data, error } = await supabase
      .from("jobs")
      .upsert(rowsToInsert.slice(batchStart, batchStart + BATCH_SIZE), {
        onConflict: "company,job_id",
        ignoreDuplicates: true, // ON CONFLICT DO NOTHING
      })
      .select();
    if (error) throw new Error(`Supabase insert failed: ${error.message}`);
    newJobs.push(...data);
  }

  const updatedJobs = [];
  for (let batchStart = 0; batchStart < rowsToMarkUpdated.length; batchStart += BATCH_SIZE) {
    const { data, error } = await supabase
      .from("jobs")
      .upsert(rowsToMarkUpdated.slice(batchStart, batchStart + BATCH_SIZE), {
        onConflict: "company,job_id", // row exists → overwrite its columns (ON CONFLICT DO UPDATE)
      })
      .select();
    if (error) throw new Error(`Supabase update failed: ${error.message}`);
    updatedJobs.push(...data);
  }
  await unarchiveJobs(updatedJobs);

  return [...newJobs, ...updatedJobs];
}

// ---------- Hidden titles (table: hidden_titles) ----------

// Titles you marked "Always hide this title" on the dashboard, already normalized there.
export async function loadHiddenTitles() {
  const { data, error } = await supabase.from("hidden_titles").select("title");
  if (error) throw new Error(`Supabase hidden titles load failed: ${error.message}`);
  return new Set(data.map((row) => row.title));
}

// ---------- Scraper runs (table: runs) ----------

// Called once at the end of a run. Logs on failure instead of throwing,
// so a failed health-log insert never crashes the scraper.
// GITHUB_RUN_ID is shared by every step of one workflow run; it's missing on local runs (→ null).
// savedJobs = what saveJobsAndGetNew() returned; each company's entry gets its new / updated counts.
export async function saveRun(source, companyResults, savedJobs = []) {
  const githubRunId = process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null;

  const countsByCompany = new Map();
  for (const savedJob of savedJobs) {
    const companyCounts = countsByCompany.get(savedJob.company) ?? { newCount: 0, updatedCount: 0 };
    if (savedJob.is_update) companyCounts.updatedCount += 1;
    else companyCounts.newCount += 1;
    countsByCompany.set(savedJob.company, companyCounts);
  }
  const reportWithCounts = companyResults.map((companyResult) => ({
    ...companyResult,
    ...(countsByCompany.get(companyResult.company) ?? { newCount: 0, updatedCount: 0 }),
  }));

  const { error } = await supabase.from("runs").insert({
    run_id: githubRunId,
    source,
    scraped_at: new Date().toISOString(),
    report: reportWithCounts,
  });
  if (error) console.error(`Supabase run insert failed (${source}): ${error.message}`);
}