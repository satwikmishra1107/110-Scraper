// custom/amazon.mjs | run: node custom/amazon.mjs

// ---------- Settings you can change ----------
const MAX_POSTING_AGE_DAYS = 7;
const JOBS_PER_PAGE = 50;
const MAX_PAGES_TO_FETCH = 40;    // Increased to 40 to safely cover all of Amazon's current job volume
const REQUEST_TIMEOUT_MS = 15000;

// Matches whole words only. Useful as a secondary filter even if Amazon categorizes it as "Software Development"
const SOFTWARE_TITLE_PATTERN =
  /\b(software|engineers?|engineering|technical|developers?|developer|sde|sdet|backend|back-end|frontend|front-end|full[- ]?stack|systems?|architect|ui|ux|react|node|java|c\+\+|typescript|mongo)\b/i;
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

// ---------- Small helpers ----------
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title) {
  return SOFTWARE_TITLE_PATTERN.test(title || "");
}

function getDaysSincePosted(dateString, currentTimeInMilliseconds) {
  const postedDate = new Date(dateString);

  // If the date cannot be read, treat the job as brand new instead of dropping it
  if (isNaN(postedDate.getTime())) return 0;

  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

// ---------- Scrape Amazon (all pages) ----------
async function scrapeAmazon() {
  const currentTimeInMilliseconds = Date.now();
  const matchingJobs = [];

  const skipCounts = { tooOld: 0, notSoftware: 0 };
  let totalJobsChecked = 0;

  for (let pageNumber = 0; pageNumber < MAX_PAGES_TO_FETCH; pageNumber++) {
    const offset = pageNumber * JOBS_PER_PAGE;
    
    // API naturally filters for IND and software-development category
    const apiUrl = `https://www.amazon.jobs/en/search.json?category%5B%5D=software-development&normalized_country_code%5B%5D=IND&offset=${offset}&result_limit=${JOBS_PER_PAGE}&sort=recent`;

    log(`   Fetching page ${pageNumber + 1} (offset ${offset})...`);

    const response = await fetch(apiUrl, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching page ${pageNumber + 1}`);
    }

    const data = await response.json();
    const jobsOnThisPage = data.jobs || [];

    if (pageNumber === 0 && data.hits !== undefined) {
      log(`   API reports ${data.hits} total jobs matching category/location`);
    }

    log(`   Page ${pageNumber + 1} returned ${jobsOnThisPage.length} jobs`);

    if (jobsOnThisPage.length === 0) break;

    for (const job of jobsOnThisPage) {
      totalJobsChecked++;

      const daysSincePosted = getDaysSincePosted(job.posted_date, currentTimeInMilliseconds);

      // We DO NOT break here anymore because Amazon's sorting algorithm is buggy.
      // We just skip this specific job and keep checking the rest of the array.
      if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
        skipCounts.tooOld++;
        continue;
      }

      if (!isSoftwareJob(job.title)) {
        skipCounts.notSoftware++;
        continue;
      }

      matchingJobs.push({
        company: "Amazon",
        title: job.title,
        department: job.business_category || "N/A",
        location: job.normalized_location || job.city || "India",
        daysSincePosted: daysSincePosted,
        url: `https://www.amazon.jobs${job.job_path}`
      });
    }

    // Stop if the page isn't full (means we've reached the absolute end of the list)
    const isLastPage = jobsOnThisPage.length < JOBS_PER_PAGE;

    if (isLastPage) {
      log(`   That was the last page, stopping.`);
      break;
    }

    // Brief delay to be polite to Amazon's servers
    if (pageNumber < MAX_PAGES_TO_FETCH - 1) {
      await delay(500);
    }
  }

  log(`   Checked ${totalJobsChecked} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
async function main() {
  const startTimeInMilliseconds = Date.now();

  log(`Starting Amazon scraper`);
  log(`Looking for India software jobs posted in the last ${MAX_POSTING_AGE_DAYS} days`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  log(`▶ Amazon (amazon.jobs)`);

  try {
    const jobsFromThisCompany = await scrapeAmazon();
    allJobs.push(...jobsFromThisCompany);
    log(`✅ Amazon done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ Amazon failed: ${error.message}`);
  }

  console.log("");
  console.log("=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, jobIndex) => {
    const postedText = job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`;

    console.log(`${jobIndex + 1}. [${job.company}] ${job.title} (${job.department})`);
    console.log(`   Location: ${job.location} | Posted: ${postedText}`);
    console.log(`   Link: ${job.url}`);
    console.log("");
  });

  const secondsTaken = ((Date.now() - startTimeInMilliseconds) / 1000).toFixed(1);
  log(`Finished in ${secondsTaken} seconds`);

  if (scrapeFailed) {
    log(`⚠️ Amazon scraper failed to finish correctly.`);
  }
}

await main();