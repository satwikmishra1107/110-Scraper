// custom/rippling.mjs | run: node custom/rippling.mjs
import { pathToFileURL } from "node:url";

// ---------- Settings ----------
const JOBS_PER_PAGE = 100; // the largest page size the API accepts
// Safety cap only: pagination normally ends at the API's own totalPages
const MAX_PAGES_TO_FETCH = 50;
const REQUEST_TIMEOUT_MS = 15000;

// Rippling's own ATS board API (the one ats.rippling.com/rippling/jobs loads)
const URL = "https://ats.rippling.com/api/v2/board/rippling/jobs";

const SD_KEYWORDS = [
  "software",
  "engineer",
  "engineering",
  "technical",
  "developer",
  "backend",
  "frontend",
  "back-end",
  "front-end",
  "full stack",
  "full-stack",
  "system",
  "architect",
  "ui",
  "ux",
  "sde",
  "sdet",
  "react",
  "node",
  "java",
  "c\\+\\+", // + must be escaped: an unescaped "c++" crashes the regex below
  "typescript",
  "mongo",
];

// Matches whole words, optionally ending with 's' or 'ing'
const SD_REGEX = new RegExp(`\\b(?:${SD_KEYWORDS.join("|")})(?:s|ing)?\\b`, "i");

// ---------- Helpers ----------
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title, department) {
  return SD_REGEX.test(title || "") || SD_REGEX.test(department || "");
}

// Each location carries an ISO country code, so no city list is needed
function getIndiaLocations(job) {
  return (job.locations || []).filter(location => location.countryCode === "IN");
}

// ---------- Scraper Logic ----------
async function scrapeRippling() {
  const matchingJobs = [];
  const skipCounts = { notSoftware: 0, notIndia: 0 };
  let totalJobsChecked = 0;
  let totalJobsInAPI = null;

  for (let pageNumber = 0; pageNumber < MAX_PAGES_TO_FETCH; pageNumber++) {
    log(`   Fetching page ${pageNumber + 1}...`);

    const response = await fetch(`${URL}?page=${pageNumber}&pageSize=${JOBS_PER_PAGE}`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} while fetching Rippling API page ${pageNumber + 1}`);

    const data = await response.json();
    // A missing items array means the API shape changed; fail loudly instead of reporting 0 jobs
    if (!Array.isArray(data.items)) {
      throw new Error(`Unexpected API response on page ${pageNumber + 1}: no items array`);
    }
    const jobs = data.items;

    if (pageNumber === 0) {
      totalJobsInAPI = data.totalItems ?? null;
      log(`   API reports ${totalJobsInAPI ?? "?"} total jobs globally`);
    }
    log(`   Page ${pageNumber + 1} returned ${jobs.length} jobs`);

    if (jobs.length === 0) break;

    for (const job of jobs) {
      totalJobsChecked++;

      const indiaLocations = getIndiaLocations(job);
      if (indiaLocations.length === 0) {
        skipCounts.notIndia++;
        continue;
      }

      const department = job.department?.name;
      if (!isSoftwareJob(job.name, department)) {
        skipCounts.notSoftware++;
        continue;
      }

      matchingJobs.push({
        id: String(job.id),
        company: "Rippling",
        title: job.name.trim(),
        department: department || "N/A",
        location: indiaLocations.map(location => location.name).join(" | "),
        daysSincePosted: null, // the board API has no posting date
        url: job.url
      });
    }

    // Every page is read: stop at the API's last page
    if (data.totalPages !== undefined && pageNumber + 1 >= data.totalPages) break;

    await delay(500);
  }

  log(`   Checked ${totalJobsChecked} jobs in total`);
  // Fewer jobs than the API counted means pages were missed (e.g. hit MAX_PAGES_TO_FETCH); say so
  if (totalJobsInAPI !== null && totalJobsChecked < totalJobsInAPI) {
    log(`   ⚠️ Only ${totalJobsChecked} of ${totalJobsInAPI} jobs were read`);
  }
  log(`   Skipped: ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
export async function main() {
  const startTime = Date.now();
  log(`Starting Rippling scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;
  let errorMessage = null;

  try {
    allJobs = await scrapeRippling();
    log(`✅ Rippling done`);
  } catch (error) {
    scrapeFailed = true;
    errorMessage = error.message;
    log(`❌ Rippling failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, jobIndex) => {
    console.log(`${jobIndex + 1}. [${job.company}] ${job.title} (${job.department})`);
    console.log(`   Location: ${job.location}`);
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
