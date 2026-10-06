import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } },
);

const BATCH_SIZE = 500;

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

const MIN_REPOST_GAP_DAYS = { workday: 2, custom: 2 };
const DEFAULT_MIN_REPOST_GAP_DAYS = 1;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(olderDate, newerDate) {
  return Math.round((Date.parse(newerDate) - Date.parse(olderDate)) / MILLISECONDS_PER_DAY);
}

const LOOKUP_BATCH_SIZE = 50;

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

export async function saveJobsAndGetNew(jobs) {
  const unique = [...new Map(jobs.map((job) => [`${job.company}|${job.job_id}`, job])).values()];
  const rows = unique.map(({ scraped_at, ...row }) => row); 

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
      rowsToMarkUpdated.push({ ...row, is_update: true, reposted_at: new Date().toISOString() });
    }
  }

  const newJobs = [];
  for (let batchStart = 0; batchStart < rowsToInsert.length; batchStart += BATCH_SIZE) {
    const { data, error } = await supabase
      .from("jobs")
      .upsert(rowsToInsert.slice(batchStart, batchStart + BATCH_SIZE), {
        onConflict: "company,job_id",
        ignoreDuplicates: true, 
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
        onConflict: "company,job_id", 
      })
      .select();
    if (error) throw new Error(`Supabase update failed: ${error.message}`);
    updatedJobs.push(...data);
  }
  await unarchiveJobs(updatedJobs);

  return [...newJobs, ...updatedJobs];
}

export async function loadHiddenTitles() {
  const { data, error } = await supabase.from("hidden_titles").select("title");
  if (error) throw new Error(`Supabase hidden titles load failed: ${error.message}`);
  return new Set(data.map((row) => row.title));
}

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
