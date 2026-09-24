// custom/myntra.mjs | run: node custom/myntra.mjs

const MAX_POSTING_AGE_DAYS = 7;
const JOBS_PER_PAGE = 50;
const MAX_PAGES_TO_FETCH = 20; 
const REQUEST_TIMEOUT_MS = 15000;

const SOFTWARE_PATTERN =
  /\b(software|engineers?|engineering|technical|developers?|developer|sde|sdet|backend|back-end|frontend|front-end|full[- ]?stack|systems?|architect|ui|ux|react|node|java|c\+\+|typescript|mongo)\b/i;
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title) {
  return SOFTWARE_PATTERN.test(title || "");
}

function getDaysSincePosted(dateString, currentTimeInMilliseconds) {
  const postedDate = new Date(dateString);
  if (isNaN(postedDate.getTime())) return 0;
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

async function scrapeMyntra() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notSoftware: 0 };
  let totalJobsChecked = 0;

  for (let page = 1; page <= MAX_PAGES_TO_FETCH; page++) {
    log(`   Fetching page ${page}...`);
    
    const apiUrl = `https://io.spire2grow.com/ies/v1/p/requisition/_search?page=${page}&size=${JOBS_PER_PAGE}&selectedSortOrder=desc&selectedSortField=postedOn`;
    
    const response = await fetch(apiUrl, {
      headers: {
        "Accept": "*/*",
        "workspaceid": "MYNTRA-93as3",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} while fetching Myntra API`);

    const data = await response.json();
    const entities = data.entities || [];

    log(`   Page ${page} returned ${entities.length} jobs`);
    if (entities.length === 0) break;

    let foundOldJob = false;

    for (const job of entities) {
      totalJobsChecked++;

      const timestamp = job.jobPosting?.startDate || job.updatedOn;
      const daysSincePosted = getDaysSincePosted(timestamp, currentTime);

      // Myntra strictly sorts by date descending, so we CAN break safely
      if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
        skipCounts.tooOld++;
        foundOldJob = true;
        continue;
      }

      if (!isSoftwareJob(job.jobTitle)) {
        skipCounts.notSoftware++;
        continue;
      }

      matchingJobs.push({
        company: "Myntra",
        title: job.jobTitle,
        department: "N/A",
        location: job.jobLocation?.[0]?.city || "Bengaluru",
        daysSincePosted: daysSincePosted,
        url: `https://careers.myntra.com/jobs/${job.id}`
      });
    }

    if (foundOldJob) {
      log(`   Reached jobs older than ${MAX_POSTING_AGE_DAYS} days, stopping early.`);
      break;
    }
  }

  log(`   Checked ${totalJobsChecked} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

async function main() {
  const startTime = Date.now();
  log(`Starting Myntra scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapeMyntra();
    log(`✅ Myntra done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ Myntra failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, i) => {
    const postedText = job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`;
    console.log(`${i + 1}. [${job.company}] ${job.title}`);
    console.log(`   Location: ${job.location} | Posted: ${postedText}`);
    console.log(`   Link: ${job.url}\n`);
  });

  log(`Finished in ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`);
  if (scrapeFailed) log(`⚠️ Scraper failed to finish correctly.`);
}

await main();