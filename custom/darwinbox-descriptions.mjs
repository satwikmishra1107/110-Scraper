// custom/darwinbox-descriptions.mjs — job descriptions for the Darwinbox scrapers (airtel.mjs, delhivery.mjs).
// Not a scraper itself, so it isn't listed in run-all.mjs.
// The job list API leaves `jd` empty; the one-job API has it. Both sit behind Cloudflare, so the request is made
// from inside the scraper's browser page (already cleared), like the list requests are.
import { decodeHtmlEntities, htmlToText } from "../score/descriptions.mjs";
import { loadJobIdsWithDescription } from "../store.mjs";

// One quick API call per job, so this is generous. Jobs with no description posted are asked again every run
const MAX_DESCRIPTIONS_PER_RUN = 60;
const MAX_DESCRIPTION_CHARS = 20_000; // same cap as score/descriptions.mjs

const log = (message) => console.log(`[${new Date().toLocaleTimeString()}] ${message}`);

/** The job page on the current (v2) careers site. The old /ms/candidate/job/job_detail/id/<id> link lands on the home page */
export const darwinboxJobUrl = (host, jobId) => `https://${host}/ms/candidatev2/main/careers/jobDetails/${jobId}`;

/** Sets job.description on the jobs that have no saved description yet. `page` must already be on the Darwinbox site */
export async function addDarwinboxDescriptions(page, jobs, company) {
  let describedJobIds = new Set();
  try {
    describedJobIds = await loadJobIdsWithDescription(company);
  } catch (error) {
    // Without the list every job looks new; the per-run cap keeps that bounded
    log(`   ⚠️ ${error.message}`);
  }

  const jobsWithoutDescription = jobs.filter((job) => !describedJobIds.has(job.id));
  const jobsToDescribe = jobsWithoutDescription.slice(0, MAX_DESCRIPTIONS_PER_RUN);
  log(`   Reading descriptions for ${jobsToDescribe.length} jobs (${jobs.length - jobsWithoutDescription.length} already saved)...`);

  const counts = { read: 0, notPosted: 0, failed: 0 };
  for (const job of jobsToDescribe) {
    // Runs INSIDE Chromium; returns raw text so a Cloudflare HTML page shows up as an error, not "Unexpected token <"
    const apiResult = await page.evaluate(async (jobId) => {
      try {
        const res = await fetch(`/ms/candidateapi/job/${jobId}?companyId=main`, { headers: { Accept: "application/json" } });
        return { status: res.status, ok: res.ok, bodyText: await res.text() };
      } catch (fetchError) {
        return { fetchError: fetchError.message };
      }
    }, job.id);

    try {
      if (!apiResult.ok) throw new Error(apiResult.fetchError || `HTTP ${apiResult.status}`);
      // `jd` is HTML with its tags escaped ("&lt;p&gt;"), so it's decoded once before the tags come off
      const escapedHtml = JSON.parse(apiResult.bodyText).message?.job?.[0]?.jd || "";
      const description = htmlToText(decodeHtmlEntities(escapedHtml)).slice(0, MAX_DESCRIPTION_CHARS);
      if (description) {
        job.description = description;
        counts.read++;
      } else {
        // The site itself shows "No job description at the moment!" for these. Such a job can never be scored,
        // so run-all.mjs pings it straight away instead of leaving it to the scoring step
        job.noDescriptionPosted = true;
        counts.notPosted++;
      }
    } catch (error) {
      // Not fatal: the job is still saved, and its description is tried again next run
      counts.failed++;
      log(`   ⚠️ No description for "${job.title}": ${error.message}`);
    }
  }
  log(`   Descriptions: read ${counts.read}, none posted ${counts.notPosted}, failed ${counts.failed}`);
}
