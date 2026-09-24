// ashby/ashby.mjs | run from repo root: node ashby/ashby.mjs
import {
  loadCompanies, fetchJson, isIndiaLocation, isSoftwareDomain, daysSince, MAX_POSTING_AGE_DAYS,
  toRow, runSource, runStandalone,
} from "../ats-common.mjs";

const SOURCE = "ashby";
const COMPANIES = loadCompanies("./ashby/ashby.json");

async function scrapeCompany(company, scrapedAt) {
  const data = await fetchJson(
    `https://api.ashbyhq.com/posting-api/job-board/${company.slug}?includeCompensation=true`,
  );
  return (data.jobs || [])
    .filter((job) =>
      job.isListed && // skip hidden/internal jobs
      isIndiaLocation(job.location || "Unknown") &&
      isSoftwareDomain(job.title, job.department || "N/A") &&
      daysSince(job.publishedAt) <= MAX_POSTING_AGE_DAYS)
    .map((job) => toRow({
      source: SOURCE, company: company.company, jobId: job.id, title: job.title,
      location: job.location, url: job.jobUrl, postedAt: job.publishedAt, scrapedAt,
    }));
}

export const runAll = () => runSource(SOURCE, COMPANIES, scrapeCompany);
await runStandalone(import.meta.url, runAll);
