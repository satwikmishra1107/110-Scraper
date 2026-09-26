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
    // posted_date is "YYYY-MM-DD", so comparing the strings compares the dates
    if (row.posted_date && storedPostedDate && row.posted_date > storedPostedDate) {
      // New first_seen_at = the board counts it as found now, so it moves back to the top
      rowsToMarkUpdated.push({ ...row, is_update: true, first_seen_at: new Date().toISOString() });
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

// ---------- Scraper runs (table: runs) ----------

// Called once at the end of a run. Logs on failure instead of throwing,
// so a failed health-log insert never crashes the scraper.
// GITHUB_RUN_ID is shared by every step of one workflow run; it's missing on local runs (→ null).
export async function saveRun(source, companyResults) {
  const githubRunId = process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null;
  const { error } = await supabase.from("runs").insert({
    run_id: githubRunId,
    source,
    scraped_at: new Date().toISOString(),
    report: companyResults,
  });
  if (error) console.error(`Supabase run insert failed (${source}): ${error.message}`);
}