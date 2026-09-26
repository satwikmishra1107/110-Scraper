// ats-common.mjs — shared helpers for the JSON-API ATS scrapers (greenhouse, lever, ashby, smartrecruiters).
// Lives next to store.mjs. Row shape matches workday.mjs so saveJobsAndGetNew() handles every source.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import { saveJobsAndGetNew, saveRun } from "./store.mjs";
import { sendTelegramAlerts } from "./telegram.mjs";

const REQUEST_TIMEOUT_MS = 30_000;
const COMPANY_DELAY_MS = 500;

// ---- Original filter logic (unchanged from the pre-Supabase scripts) ----
export const MAX_POSTING_AGE_DAYS = 1;
const NOW = Date.now();

const SD_KEYWORDS = [
  "software",
  "engineer",
  "engineering",
  "technical",
  "developer",
  "backend",
  "frontend",
  "back-end",
  "front-end",
  "full stack",
  "full-stack",
  "system",
  "architect",
  "ui",
  "ux",
  "sde",
  "sdet",
  "react",
  "node",
  "java",
  "c++",
  "typescript",
  "mongo",
];
const INDIA_LOCATIONS = [
  "india",
  "bengaluru",
  "bangalore",
  "hyderabad",
  "mumbai",
  "pune",
  "gurgaon",
  "noida",
  "delhi",
  "chennai",
];

export function isIndiaLocation(locationName) {
  if (!locationName) return false;
  const locLower = locationName.toLowerCase();
  return INDIA_LOCATIONS.some((city) => locLower.includes(city));
}

// Greenhouse/Lever called this with title only; Ashby/SmartRecruiters also passed department.
export function isSoftwareDomain(title, department) {
  const titleLower = (title || "").toLowerCase();
  const deptLower = (department || "").toLowerCase();
  if (SD_KEYWORDS.some((kw) => titleLower.includes(kw))) return true;
  if (deptLower.includes("engineering") || deptLower.includes("infrastructure"))
    return true;
  return false;
}

export const daysSince = (postedAt) =>
  Math.floor((NOW - new Date(postedAt).getTime()) / (1000 * 60 * 60 * 24));

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const loadCompanies = (path) =>
  JSON.parse(fs.readFileSync(path, "utf8"));

// GET JSON with timeout; retries network errors, 429 and 5xx. Other statuses (404 = bad slug) fail fast.
export async function fetchJson(url, maxAttempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return await res.json();
      lastError = new Error(
        res.status === 404
          ? "HTTP 404 - bad slug or private board"
          : `HTTP ${res.status}`,
      );
      lastError.status = res.status;
      if (res.status !== 429 && res.status < 500) throw lastError;
    } catch (error) {
      if (error === lastError) throw error;
      lastError = error;
    }
    if (attempt < maxAttempts) {
      console.log(
        `  └─ ${lastError.message} — retrying (attempt ${attempt}/${maxAttempts})`,
      );
      await delay(2000 * attempt);
    }
  }
  throw new Error(
    `${lastError.message} (gave up after ${maxAttempts} attempts)`,
  );
}

// Same columns as workday.mjs's toNormalizedJob().
export function toRow({
  source,
  company,
  jobId,
  title,
  location,
  url,
  postedAt,
  scrapedAt,
}) {
  const iso = new Date(postedAt).toISOString();
  return {
    source,
    company,
    job_id: String(jobId), // unique key together with `company`
    title,
    location: location || null,
    url,
    posted_label: iso, // raw timestamp from the ATS
    posted_date: iso.slice(0, 10),
    scraped_at: scrapedAt,
  };
}

// Mirrors workday.mjs runAll(): same return shape and report rows.
export async function runSource(source, companies, scrapeCompany) {
  console.log(
    `\nLoaded ${companies.length} companies for ${source}.\nStarting ${source} scraper...\n`,
  );
  const scrapedAt = new Date().toISOString();
  const report = [];
  const jobs = [];

  for (const company of companies) {
    console.log(`Processing: ${company.company}`);
    try {
      const found = await scrapeCompany(company, scrapedAt);
      jobs.push(...found);
      report.push({
        company: company.company,
        ok: true,
        count: found.length,
        error: null,
      });
      console.log(`  └─ Success: Found ${found.length} recent jobs.\n`);
    } catch (error) {
      report.push({
        company: company.company,
        ok: false,
        count: 0,
        error: error.message,
      });
      console.log(`  └─ Failed: ${error.message}\n`);
    }
    await delay(COMPANY_DELAY_MS);
  }
  return { source, scraped_at: scrapedAt, jobs, report };
}

// Standalone entrypoint: `node <source>/<source>.mjs` from the repo root. No-op when imported.
export async function runStandalone(metaUrl, runAll) {
  if (metaUrl !== pathToFileURL(process.argv[1]).href) return;
  const result = await runAll();

  console.log(`=== FINAL ${result.source.toUpperCase()} REPORT ===`);
  console.table(result.report);
  console.log(`\nTotal jobs collected: ${result.jobs.length}\n`);

  const newJobs = await saveJobsAndGetNew(result.jobs);
  console.log(`\n=== NEW JOBS (not seen before): ${newJobs.length} ===`);

  await sendTelegramAlerts(result.source, newJobs);
  await saveRun(result.source, result.report);

  if (result.report.length && result.report.every((r) => !r.ok))
    process.exitCode = 1;
}
