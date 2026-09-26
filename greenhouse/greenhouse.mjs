// greenhouse/greenhouse.mjs | run from repo root: node greenhouse/greenhouse.mjs
import {
  loadCompanies, fetchJson, isIndiaLocation, isSoftwareDomain, daysSince, MAX_POSTING_AGE_DAYS,
  toRow, runSource, runStandalone,
} from "../ats-common.mjs";

const SOURCE = "greenhouse";
const COMPANIES = loadCompanies("./greenhouse/greenhouse.json");

// first_published = when the job first went live. updated_at changes whenever a company
// re-saves its board (often every job at once), so it's only a fallback.
const getPostedAt = (job) => job.first_published ?? job.updated_at;

async function scrapeCompany(company, scrapedAt) {
  const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs`);
  return (data.jobs || [])
    .filter((job) =>
      isIndiaLocation(job.location?.name) &&
      isSoftwareDomain(job.title) &&
      daysSince(getPostedAt(job)) <= MAX_POSTING_AGE_DAYS)
    .map((job) => toRow({
      source: SOURCE, company: company.company, jobId: job.id, title: job.title,
      location: job.location.name, url: job.absolute_url, postedAt: getPostedAt(job), scrapedAt,
    }));
}

export const runAll = () => runSource(SOURCE, COMPANIES, scrapeCompany);
await runStandalone(import.meta.url, runAll);
