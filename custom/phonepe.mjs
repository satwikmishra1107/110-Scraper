// custom/phonepe.mjs | run: node custom/phonepe.mjs

const MAX_POSTING_AGE_DAYS = 7;
const REQUEST_TIMEOUT_MS = 15000;
const URL = "https://www.phonepe.com/apollo/job-postings/latest.json";

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

function parseDotNetDate(dateStr) {
  if (!dateStr) return new Date(0);
  const match = dateStr.match(/\d+/);
  if (match) return new Date(parseInt(match[0], 10));
  return new Date(dateStr); 
}

function getDaysSincePosted(dateStr, currentTimeInMilliseconds) {
  const postedDate = parseDotNetDate(dateStr);
  if (isNaN(postedDate.getTime())) return 0;
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

async function scrapePhonePe() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notSoftware: 0, notPublic: 0 };
  
  log(`   Fetching all jobs from PhonePe...`);

  const response = await fetch(URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching PhonePe API`);

  const data = await response.json();
  const jobs = data.results || [];
  
  log(`   Found ${jobs.length} total jobs in system`);

  for (const job of jobs) {
    const isPublic = job.status === "PUBLIC" || job.status === "PUBLISHED";
    if (!isPublic || !job.applyUrl) {
      skipCounts.notPublic++;
      continue;
    }

    if (!isSoftwareJob(job.title)) {
      skipCounts.notSoftware++;
      continue;
    }

    const daysSincePosted = getDaysSincePosted(job.updatedAt, currentTime);

    if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
      skipCounts.tooOld++;
      continue;
    }

    matchingJobs.push({
      company: "PhonePe",
      title: job.title,
      department: job.department || "N/A",
      location: job.location || "India",
      daysSincePosted: daysSincePosted,
      url: job.applyUrl
    });
  }

  log(`   Checked ${jobs.length} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software, ${skipCounts.notPublic} internal`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

async function main() {
  const startTime = Date.now();
  log(`Starting PhonePe scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapePhonePe();
    log(`✅ PhonePe done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ PhonePe failed: ${error.message}`);
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