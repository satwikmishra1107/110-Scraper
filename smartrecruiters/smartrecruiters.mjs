// smartrecruiters/smartrecruiters.mjs | run from repo root: node smartrecruiters/smartrecruiters.mjs
import {
  loadCompanies, fetchJson, isSoftwareDomain, daysSince, MAX_POSTING_AGE_DAYS,
  toRow, runSource, runStandalone, delay,
} from "../ats-common.mjs";

const SOURCE = "smartrecruiters";
const COMPANIES = loadCompanies("./smartrecruiters/smartrecruiters.json");
const LIMIT = 100;

function isIndia(job) {
  const countryCode = (job.location?.country || "").toLowerCase();
  const city = (job.location?.city || "").toLowerCase();
  return countryCode === "in" || countryCode === "india" || city.includes("bengaluru") ||
    city.includes("bangalore") || city.includes("mumbai") || city.includes("hyderabad");
}

async function scrapeCompany(company, scrapedAt) {
  const rows = [];
  let offset = 0;
  let totalFound = Infinity;

  while (offset < totalFound) {
    const data = await fetchJson(
      `https://api.smartrecruiters.com/v1/companies/${company.slug}/postings?limit=${LIMIT}&offset=${offset}`,
    );
    totalFound = data.totalFound || 0;
    const jobs = data.content || [];
    if (jobs.length === 0) break;

    for (const job of jobs) {
      if (!isIndia(job)) continue;
      if (!isSoftwareDomain(job.name, job.department?.label || "N/A")) continue;
      if (daysSince(job.releasedDate) > MAX_POSTING_AGE_DAYS) continue;
      rows.push(toRow({
        source: SOURCE, company: company.company, jobId: job.id, title: job.name,
        location: job.location?.city || "India",
        url: `https://jobs.smartrecruiters.com/${company.slug}/${job.id}`,
        postedAt: job.releasedDate, scrapedAt,
      }));
    }

    offset += LIMIT;
    await delay(500);
  }
  return rows;
}

export const runAll = () => runSource(SOURCE, COMPANIES, scrapeCompany);
await runStandalone(import.meta.url, runAll);
