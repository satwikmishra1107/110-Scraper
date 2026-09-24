// custom/makemytrip.mjs | run: node custom/makemytrip.mjs

const MAX_POSTING_AGE_DAYS = 7;
const REQUEST_TIMEOUT_MS = 15000;
const URL = "https://careers.makemytrip.com/api/jobs";

// Matches whole words only
const SOFTWARE_PATTERN =
  /\b(software|engineers?|engineering|technical|developers?|developer|sde|sdet|backend|back-end|frontend|front-end|full[- ]?stack|systems?|architect|ui|ux|react|node|java|c\+\+|typescript|mongo)\b/i;
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title, department) {
  return SOFTWARE_PATTERN.test(title || "") || SOFTWARE_PATTERN.test(department || "");
}

function parseDarwinboxDate(dateStr) {
  if (!dateStr) return new Date(0);
  const [datePart, timePart] = dateStr.split(' ');
  const [day, month, year] = datePart.split('-');
  return new Date(`${year}-${month}-${day}T${timePart}Z`);
}

function getDaysSincePosted(dateStr, currentTimeInMilliseconds) {
  const postedDate = parseDarwinboxDate(dateStr);
  if (isNaN(postedDate.getTime())) return 0;
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

async function scrapeMakeMyTrip() {
  const currentTimeInMilliseconds = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notIndia: 0, notSoftware: 0, notPublic: 0 };
  
  log(`   Fetching all jobs from MakeMyTrip...`);

  const response = await fetch(URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching MakeMyTrip API`);

  const data = await response.json();
  const jobs = data.allJobs || [];
  
  log(`   Found ${jobs.length} total jobs in system`);

  for (const job of jobs) {
    if (job.post_on_careers_page !== 1) {
      skipCounts.notPublic++;
      continue;
    }

    if (job.location_country !== "India") {
      skipCounts.notIndia++;
      continue;
    }

    if (!isSoftwareJob(job.job_title, job.department)) {
      skipCounts.notSoftware++;
      continue;
    }

    const timestamp = job.job_updated_timestamp || job.job_created_timestamp;
    const daysSincePosted = getDaysSincePosted(timestamp, currentTimeInMilliseconds);

    if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
      skipCounts.tooOld++;
      continue;
    }

    matchingJobs.push({
      company: "MakeMyTrip",
      title: job.job_title,
      department: job.department || "N/A",
      location: job.location?.[0] || job.location_city?.[0] || "India",
      daysSincePosted: daysSincePosted,
      url: `https://careers.makemytrip.com/job-description/?job_id=${job.job_id}`
    });
  }

  log(`   Checked ${jobs.length} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notIndia} not India, ${skipCounts.notSoftware} not software, ${skipCounts.notPublic} internal`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

async function main() {
  const startTime = Date.now();
  log(`Starting MakeMyTrip scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapeMakeMyTrip();
    log(`✅ MakeMyTrip done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ MakeMyTrip failed: ${error.message}`);
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