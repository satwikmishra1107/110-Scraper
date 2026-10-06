// custom/hubspot.mjs | run: node custom/hubspot.mjs
// HubSpot left Greenhouse for Gem. Gem's public job board API returns every open job in one call.
// The "hubspot" board exists (an unknown board gives 404) but may be empty while they migrate,
// so 0 jobs is a normal result here, not a failure.
import { pathToFileURL } from "node:url";

const REQUEST_TIMEOUT_MS = 15000;
const URL = "https://api.gem.com/job_board/v0/hubspot/job_posts/";

const SOFTWARE_PATTERN =
  /\b(software|engineers?|engineering|technical|developers?|developer|sde|sdet|backend|back-end|frontend|front-end|full[- ]?stack|react|node|java|c\+\+|typescript|mongo)\b/i;
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

// Whole words only, so "Indianapolis, Indiana" does not count as India
const INDIA_LOCATION_REGEX =
  /\b(india|bengaluru|bangalore|hyderabad|mumbai|pune|gurgaon|gurugram|noida|delhi|chennai)\b/i;

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

// Engineering titles, or anything in an Engineering department
function isSoftwareJob(title, departmentNames) {
  return SOFTWARE_PATTERN.test(title || "") || departmentNames.some((name) => /engineering/i.test(name));
}

// A job can list several offices; it counts if any of them is in India
function getLocationText(job) {
  const names = [job.location?.name, ...(job.offices ?? []).map((office) => office.location?.name ?? office.name)];
  return [...new Set(names.filter(Boolean))].join(" | ");
}

function getDaysSincePosted(dateString, currentTimeInMilliseconds) {
  const postedDate = new Date(dateString);
  if (isNaN(postedDate.getTime())) return null;
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

async function scrapeHubSpot() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { notSoftware: 0, notIndia: 0 };

  log(`   Fetching all jobs from HubSpot's Gem board...`);

  const response = await fetch(URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching HubSpot's Gem board`);

  const jobs = await response.json();
  // Anything but an array means the API shape changed; fail loudly instead of reporting 0 jobs
  if (!Array.isArray(jobs)) {
    throw new Error(`Unexpected API response: not a list of jobs`);
  }

  log(`   Found ${jobs.length} total globally`);

  for (const job of jobs) {
    const locationText = getLocationText(job);
    if (!INDIA_LOCATION_REGEX.test(locationText)) {
      skipCounts.notIndia++;
      continue;
    }

    const departmentNames = (job.departments ?? []).map((department) => department.name);
    if (!isSoftwareJob(job.title, departmentNames)) {
      skipCounts.notSoftware++;
      continue;
    }

    matchingJobs.push({
      id: String(job.id),
      company: "HubSpot",
      title: job.title,
      department: departmentNames.join(", ") || "N/A",
      location: locationText,
      // When it went live on the board; jobs carried over from Greenhouse keep an older created_at
      daysSincePosted: getDaysSincePosted(job.first_published_at ?? job.created_at, currentTime),
      url: job.absolute_url,
    });
  }

  log(`   Skipped: ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

export async function main() {
  const startTime = Date.now();
  log(`Starting HubSpot scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;
  let errorMessage = null;

  try {
    allJobs = await scrapeHubSpot();
    log(`✅ HubSpot done`);
  } catch (error) {
    scrapeFailed = true;
    errorMessage = error.message;
    log(`❌ HubSpot failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, jobIndex) => {
    const postedText = job.daysSincePosted === null ? "Unknown" : job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`;
    console.log(`${jobIndex + 1}. [${job.company}] ${job.title} (${job.department})`);
    console.log(`   Location: ${job.location} | Posted: ${postedText}`);
    console.log(`   Link: ${job.url}\n`);
  });

  log(`Finished in ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`);
  if (scrapeFailed) log(`⚠️ Scraper failed to finish correctly.`);

  // Hand the results back to whoever called main() (the common custom runner)
  return { allJobs, scrapeFailed, errorMessage };
}

// Run main() only when started directly (node custom/<file>.mjs),
// not when the common custom runner imports this file
const isRunDirectly = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  await main();
}
