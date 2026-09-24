// custom/oracle.mjs | run: node custom/oracle.mjs

// ---------- Settings ----------
const MAX_POSTING_AGE_DAYS = 7;
const JOBS_PER_PAGE = 25;
const MAX_PAGES_TO_FETCH = 20; 
const REQUEST_TIMEOUT_MS = 15000;

const HOST = "eeho.fa.us2.oraclecloud.com";
const SITE_NUMBER = "CX_45001";
const LOCATION_ID = "300000000106947"; // Oracle's internal ID for India

const SD_KEYWORDS = [
  "software", "engineer", "engineering", "technical", "developer",
  "backend", "frontend", "back-end", "front-end", "full stack",
  "full-stack", "system", "architect", "ui", "ux", "sde", "sdet",
  "react", "node", "java", "c\\+\\+", "typescript", "mongo"
];

// Matches whole words, optionally ending with 's' or 'ing'
const SD_REGEX = new RegExp(`\\b(?:${SD_KEYWORDS.join("|")})(?:s|ing)?\\b`, "i");
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

// ---------- Helpers ----------
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title, description) {
  return SD_REGEX.test(title || "") || SD_REGEX.test(description || "");
}

function isIndiaLocation(job) {
  const locationText = job.PrimaryLocation || "";
  if (/india/i.test(locationText) || job.PrimaryLocationCountry === "IN") return true;
  
  // Check secondary locations just in case
  if (job.secondaryLocations && Array.isArray(job.secondaryLocations)) {
    return job.secondaryLocations.some(loc => loc.CountryCode === "IN" || /india/i.test(loc.Name));
  }
  return false;
}

function getDaysSincePosted(dateString, currentTimeInMilliseconds) {
  if (!dateString) return 0;
  const postedDate = new Date(dateString);
  if (isNaN(postedDate.getTime())) return 0;
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

// ---------- Scraper Logic ----------
async function scrapeOracle() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notSoftware: 0, notIndia: 0 };
  let totalJobsChecked = 0;

  for (let pageNumber = 0; pageNumber < MAX_PAGES_TO_FETCH; pageNumber++) {
    const offset = pageNumber * JOBS_PER_PAGE;

    log(`   Fetching page ${pageNumber + 1} (offset ${offset})...`);

    // We include locationId in the finder to pre-filter jobs in India
    const finderQuery = `findReqs;siteNumber=${SITE_NUMBER},limit=${JOBS_PER_PAGE},offset=${offset},locationId=${LOCATION_ID},sortBy=POSTING_DATES_DESC`;
    
    const apiUrl = `https://${HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${encodeURIComponent(finderQuery)}`;

    const response = await fetch(apiUrl, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching page ${pageNumber + 1}`);
    }

    const data = await response.json();
    const firstItem = data.items?.[0];
    const jobsOnThisPage = firstItem?.requisitionList || [];

    if (pageNumber === 0 && firstItem?.TotalJobsCount !== undefined) {
      log(`   API reports ${firstItem.TotalJobsCount} total jobs matching location ID`);
    }

    log(`   Page ${pageNumber + 1} returned ${jobsOnThisPage.length} jobs`);

    if (jobsOnThisPage.length === 0) break;

    let foundJobOlderThanLimit = false;

    for (const job of jobsOnThisPage) {
      totalJobsChecked++;

      const daysSincePosted = getDaysSincePosted(job.PostedDate, currentTime);

      // Oracle strictly sorts by POSTING_DATES_DESC, so we can safely break early
      if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
        skipCounts.tooOld++;
        foundJobOlderThanLimit = true;
        continue;
      }

      if (!isIndiaLocation(job)) {
        skipCounts.notIndia++;
        continue;
      }

      if (!isSoftwareJob(job.Title, job.ShortDescriptionStr)) {
        skipCounts.notSoftware++;
        continue;
      }

      matchingJobs.push({
        company: "Oracle",
        title: job.Title,
        department: "N/A", // Oracle HCM rarely provides a clean department field at the top level
        location: job.PrimaryLocation || "India",
        daysSincePosted: daysSincePosted,
        url: `https://${HOST}/hcmUI/CandidateExperience/en/sites/${SITE_NUMBER}/job/${job.Id}`
      });
    }

    const isLastPage = jobsOnThisPage.length < JOBS_PER_PAGE;

    if (foundJobOlderThanLimit) {
      log(`   Reached jobs older than ${MAX_POSTING_AGE_DAYS} days. Stopping early.`);
      break;
    }
    
    if (isLastPage) {
      log(`   That was the last page. Stopping.`);
      break;
    }

    await delay(500); // Be polite to the API
  }

  log(`   Checked ${totalJobsChecked} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
async function main() {
  const startTime = Date.now();
  log(`Starting Oracle scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapeOracle();
    log(`✅ Oracle done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ Oracle failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, i) => {
    const postedText = typeof job.daysSincePosted === 'number' 
      ? (job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`) 
      : job.daysSincePosted;

    // Conditionally render department only if it's not "N/A"
    const deptString = job.department !== "N/A" ? ` (${job.department})` : "";

    console.log(`${i + 1}. [${job.company}] ${job.title}${deptString}`);
    console.log(`   Location: ${job.location} | Posted: ${postedText}`);
    console.log(`   Link: ${job.url}\n`);
  });

  log(`Finished in ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`);
  if (scrapeFailed) log(`⚠️ Scraper failed to finish correctly.`);
}

await main();