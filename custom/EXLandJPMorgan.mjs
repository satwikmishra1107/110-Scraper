// custom/oracle-hcm.mjs | run: node custom/oracle-hcm.mjs

// ---------- Settings you can change ----------
const MAX_POSTING_AGE_DAYS = 7;   // change this to 1 later for the last 24 hours
const JOBS_PER_PAGE = 50;
const MAX_PAGES_TO_FETCH = 20;    // safety limit so the loop can never run forever
const REQUEST_TIMEOUT_MS = 15000;

const COMPANIES = [
  { name: "JPMorgan", host: "jpmc.fa.oraclecloud.com", siteNumber: "CX_1001" },
  { name: "EXL", host: "fa-ewjt-saasfaprod1.fa.ocs.oraclecloud.com", siteNumber: "CX_2" },
];

// Matches whole words only, so "retail" or "Internal Audit" will not match
const SOFTWARE_TITLE_PATTERN =
  /\b(software|engineers?|engineering|technical|developers?|developer|sde|sdet|backend|back-end|frontend|front-end|full[- ]?stack|systems?|architect|ui|ux|react|node|java|c\+\+|typescript|mongo)\b/i;
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

// ---------- Small helpers ----------
function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isIndiaLocation(job) {
  const locationText = job.PrimaryLocation || "";
  return /india/i.test(locationText) || job.PrimaryLocationCountry === "IN";
}

function isSoftwareJob(job) {
  return SOFTWARE_TITLE_PATTERN.test(job.Title || "");
}

function getDaysSincePosted(job, currentTimeInMilliseconds) {
  const postedDate = new Date(job.PostedDate);

  // If the date cannot be read, treat the job as brand new instead of dropping it
  if (isNaN(postedDate.getTime())) return 0;

  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

// ---------- Fetch one page of jobs from the company's API ----------
async function fetchOnePageOfJobs(company, pageNumber) {
  const offset = pageNumber * JOBS_PER_PAGE;

  const finderQuery =
    `findReqs;siteNumber=${company.siteNumber},limit=${JOBS_PER_PAGE},offset=${offset},sortBy=POSTING_DATES_DESC`;

  const apiUrl =
    `https://${company.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
    `?onlyData=true&expand=requisitionList.secondaryLocations&finder=${encodeURIComponent(finderQuery)}`;

  log(`   Fetching page ${pageNumber + 1} (offset ${offset})...`);

  const response = await fetch(apiUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching page ${pageNumber + 1}`);
  }

  const responseData = await response.json();
  const firstItem = responseData.items?.[0];
  return firstItem?.requisitionList ?? [];
}

// ---------- Scrape one company (all pages) ----------
async function scrapeOneCompany(company) {
  const currentTimeInMilliseconds = Date.now();
  const matchingJobs = [];

  const skipCounts = { tooOld: 0, notIndia: 0, notSoftware: 0 };
  let totalJobsChecked = 0;

  for (let pageNumber = 0; pageNumber < MAX_PAGES_TO_FETCH; pageNumber++) {
    const jobsOnThisPage = await fetchOnePageOfJobs(company, pageNumber);
    log(`   Page ${pageNumber + 1} returned ${jobsOnThisPage.length} jobs`);

    if (jobsOnThisPage.length === 0) break;

    let foundJobOlderThanLimit = false;

    for (const job of jobsOnThisPage) {
      totalJobsChecked++;

      const daysSincePosted = getDaysSincePosted(job, currentTimeInMilliseconds);

      if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
        skipCounts.tooOld++;
        foundJobOlderThanLimit = true;
        continue;
      }

      if (!isIndiaLocation(job)) {
        skipCounts.notIndia++;
        continue;
      }

      if (!isSoftwareJob(job)) {
        skipCounts.notSoftware++;
        continue;
      }

      matchingJobs.push({
        id: job.Id,
        company: company.name,
        title: job.Title,
        location: job.PrimaryLocation || "India",
        daysSincePosted: daysSincePosted,
        url: `https://${company.host}/hcmUI/CandidateExperience/en/sites/${company.siteNumber}/job/${job.Id}`,
      });
    }

    // Jobs are sorted newest first, so once we see an old one we can stop
    const isLastPage = jobsOnThisPage.length < JOBS_PER_PAGE;

    if (foundJobOlderThanLimit) {
      log(`   Reached jobs older than ${MAX_POSTING_AGE_DAYS} days, stopping.`);
      break;
    }
    if (isLastPage) {
      log(`   That was the last page, stopping.`);
      break;
    }
  }

  log(`   Checked ${totalJobsChecked} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notIndia} not in India, ${skipCounts.notSoftware} not software`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
async function main() {
  const startTimeInMilliseconds = Date.now();

  log(`Starting Oracle HCM scraper`);
  log(`Companies: ${COMPANIES.map(company => company.name).join(", ")}`);
  log(`Looking for India software jobs posted in the last ${MAX_POSTING_AGE_DAYS} days`);
  console.log("");

  const allJobs = [];
  const failedCompanies = [];

  for (const company of COMPANIES) {
    log(`▶ ${company.name} (${company.host}, ${company.siteNumber})`);

    try {
      const jobsFromThisCompany = await scrapeOneCompany(company);
      allJobs.push(...jobsFromThisCompany);
      log(`✅ ${company.name} done`);
    } catch (error) {
      failedCompanies.push(company.name);
      log(`❌ ${company.name} failed: ${error.message}`);
    }

    console.log("");
  }

  console.log("=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, jobIndex) => {
    const postedText = job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`;

    console.log(`${jobIndex + 1}. [${job.company}] ${job.title}`);
    console.log(`   Location: ${job.location} | Posted: ${postedText}`);
    console.log(`   Link: ${job.url}`);
    console.log("");
  });

  const secondsTaken = ((Date.now() - startTimeInMilliseconds) / 1000).toFixed(1);
  log(`Finished in ${secondsTaken} seconds`);

  if (failedCompanies.length > 0) {
    log(`⚠️ Failed companies: ${failedCompanies.join(", ")}`);
  }
}

await main();