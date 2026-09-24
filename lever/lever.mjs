// lever/lever.mjs | run from repo root: node lever/lever.mjs
import {
  loadCompanies, fetchJson, isIndiaLocation, isSoftwareDomain, daysSince, MAX_POSTING_AGE_DAYS,
  toRow, runSource, runStandalone,
} from "../ats-common.mjs";

const SOURCE = "lever";
const COMPANIES = loadCompanies("./lever/lever.json");

async function scrapeCompany(company, scrapedAt) {
  const jobs = await fetchJson(`https://api.lever.co/v0/postings/${company.slug}?mode=json`);
  return jobs
    .filter((job) =>
      isIndiaLocation(job.categories?.location || "Unknown") &&
      isSoftwareDomain(job.text) &&
      daysSince(job.createdAt) <= MAX_POSTING_AGE_DAYS)
    .map((job) => toRow({
      source: SOURCE, company: company.company, jobId: job.id, title: job.text,
      location: job.categories?.location, url: job.hostedUrl, postedAt: job.createdAt, scrapedAt,
    }));
}

export const runAll = () => runSource(SOURCE, COMPANIES, scrapeCompany);
await runStandalone(import.meta.url, runAll);
