// custom/postman.mjs | run: node custom/postman.mjs

const MAX_POSTING_AGE_DAYS = 7;
const REQUEST_TIMEOUT_MS = 15000;
const URL = "https://www.postman.com/_mk-www-next/api-cache/careers-jobs.json";

const SOFTWARE_PATTERN =
  /\b(software|engineers?|engineering|technical|developers?|developer|sde|sdet|backend|back-end|frontend|front-end|full[- ]?stack|systems?|architect|ui|ux|react|node|java|c\+\+|typescript|mongo)\b/i;
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

const INDIA_LOCATIONS = [
  "india", "bengaluru", "bangalore", "hyderabad", 
  "mumbai", "pune", "gurgaon", "noida", "delhi", "chennai", "remote"
];

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title) {
  return SOFTWARE_PATTERN.test(title || "");
}

function isIndiaLocation(locationName) {
  if (!locationName) return false;
  const locLower = locationName.toLowerCase();
  
  if (INDIA_LOCATIONS.some(city => locLower.includes(city) && city !== "remote")) {
    return true;
  }
  if (locLower.includes("remote") && locLower.includes("india")) {
    return true;
  }
  return false;
}

function getDaysSincePosted(dateString, currentTimeInMilliseconds) {
  const postedDate = new Date(dateString);
  if (isNaN(postedDate.getTime())) return 0;
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

async function scrapePostman() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notSoftware: 0, notIndia: 0 };
  
  log(`   Fetching all jobs from Postman...`);

  const response = await fetch(URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching Postman API`);

  const data = await response.json();
  const jobs = data.jobs || [];
  
  log(`   Found ${jobs.length} total globally in system`);

  for (const job of jobs) {
    if (!isIndiaLocation(job.location)) {
      skipCounts.notIndia++;
      continue;
    }

    if (!isSoftwareJob(job.title)) {
      skipCounts.notSoftware++;
      continue;
    }

    const daysSincePosted = getDaysSincePosted(job.updated_at, currentTime);

    if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
      skipCounts.tooOld++;
      continue;
    }

    matchingJobs.push({
      company: "Postman",
      title: job.title,
      department: job.department || "N/A",
      location: job.location,
      daysSincePosted: daysSincePosted,
      url: job.url
    });
  }

  log(`   Checked ${jobs.length} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

async function main() {
  const startTime = Date.now();
  log(`Starting Postman scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapePostman();
    log(`✅ Postman done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ Postman failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, i) => {
    const postedText = job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`;
    console.log(`${i + 1}. [${job.company}] ${job.title} (${job.department})`);
    console.log(`   Location: ${job.location} | Posted: ${postedText}`);
    console.log(`   Link: ${job.url}\n`);
  });

  log(`Finished in ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`);
  if (scrapeFailed) log(`⚠️ Scraper failed to finish correctly.`);
}

await main();