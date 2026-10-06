// custom/qualcomm.mjs | run: node custom/qualcomm.mjs
// Same Eightfold "pcsx" API as microsoft.mjs, so this file mirrors it
import { pathToFileURL } from "node:url";

// Safety cap only: pages hold 10 jobs and Qualcomm lists ~600 India jobs, so this allows 1000
const MAX_PAGES_TO_FETCH = 100;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS_PER_PAGE = 3;
// Every page is fetched (the "recent" sort isn't reliable), so go slower instead of fetching less
const DELAY_BETWEEN_PAGES_MS = 5000;
// Eightfold's 429 has no Retry-After, so wait this long per attempt (30s, then 60s) before retrying
const RATE_LIMIT_COOLDOWN_MS = 30000;

const SOFTWARE_PATTERN =
  /\b(software|engineers?|engineering|technical|developers?|developer|sde|sdet|backend|back-end|frontend|front-end|full[- ]?stack|systems?|architect|ui|ux|react|node|java|c\+\+|typescript|mongo)\b/i;
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

const INDIA_LOCATIONS = [
  "india", "bengaluru", "bangalore", "hyderabad",
  "mumbai", "pune", "gurgaon", "noida", "delhi", "chennai"
];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const jitter = base => base + Math.floor(Math.random() * base * 0.4);

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title, department) {
  return SOFTWARE_PATTERN.test(title || "") || SOFTWARE_PATTERN.test(department || "");
}

// The API's location=India is a search hint, not a guarantee, so check each job too (same as HSBC)
// Whole words only, so "Indianapolis, Indiana" does not count as India
const INDIA_LOCATION_REGEX = new RegExp(`\\b(?:${INDIA_LOCATIONS.join("|")})\\b`, "i");

function isIndiaLocation(locationText) {
  if (!locationText) return false;
  return INDIA_LOCATION_REGEX.test(String(locationText));
}

function getDaysSincePosted(timestampSeconds, currentTimeInMilliseconds) {
  if (!timestampSeconds) return 0;
  const postedDate = new Date(timestampSeconds * 1000);
  if (isNaN(postedDate.getTime())) return 0;
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

// Pulls out the handful of response headers that actually explain a 429/403,
// so logs show *why* a request was blocked instead of just *that* it was.
function describeResponseHeaders(response) {
  const interesting = [
    "retry-after",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "content-type",
    "cf-ray",              // Cloudflare
    "x-akamai-request-id"  // Akamai
  ];
  const found = {};
  for (const key of interesting) {
    const value = response.headers.get(key);
    if (value) found[key] = value;
  }
  return found;
}

// Reads the body exactly once (as text) so it can be logged AND parsed —
// response.json() would throw immediately on a non-JSON block/challenge page
// and you'd never see what was actually returned.
async function fetchWithLogging(apiUrl, options, attempt) {
  const response = await fetch(apiUrl, options);
  const bodyText = await response.text();

  if (!response.ok) {
    log(`     ⚠️ HTTP ${response.status} ${response.statusText} (attempt ${attempt})`);
    const headers = describeResponseHeaders(response);
    if (Object.keys(headers).length) log(`     Headers: ${JSON.stringify(headers)}`);
    log(`     Body (first 500 chars): ${bodyText.slice(0, 500)}`);
  }

  return { response, bodyText };
}

async function scrapeQualcomm() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { notSoftware: 0, notIndia: 0 };

  let startOffset = 0;
  let totalJobsInAPI = null;
  let totalJobsChecked = 0;

  // Headers a real browser sends for a same-origin XHR call. The original
  // script's User-Agent was truncated (no "Chrome/xxx Safari/537.36" suffix)
  // — that alone is a strong bot signal — and it was missing Referer/Origin/
  // sec-fetch-* entirely, which this Eightfold.ai-hosted API likely checks.
  const commonHeaders = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Referer": "https://careers.qualcomm.com/careers?domain=qualcomm.com&location=India",
    "Origin": "https://careers.qualcomm.com",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-fetch-dest": "empty"
  };

  for (let page = 0; page < MAX_PAGES_TO_FETCH; page++) {
    log(`   Fetching page ${page + 1} (offset ${startOffset})...`);

    const apiUrl = `https://careers.qualcomm.com/api/pcsx/search?domain=qualcomm.com&location=India&start=${startOffset}&sort_by=recent`;

    let bodyText;
    let success = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PAGE; attempt++) {
      try {
        let response;
        ({ response, bodyText } = await fetchWithLogging(
          apiUrl,
          { headers: commonHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
          attempt
        ));

        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfterSeconds = Number(retryAfterHeader);
          // Retry-After can also be a date instead of seconds; Number() then gives NaN,
          // and delay(NaN) waits 0ms. Only trust it when it's a real number.
          // Last attempt: no point waiting, we're about to give up anyway
          if (attempt === MAX_ATTEMPTS_PER_PAGE) break;

          const cooldownMs = retryAfterHeader && Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds * 1000
            : jitter(attempt * RATE_LIMIT_COOLDOWN_MS);
          log(`     ⚠️ 429 Rate Limited. Cooling down for ${(cooldownMs / 1000).toFixed(1)}s...`);
          await delay(cooldownMs);
          continue;
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        success = true;
        break;
      } catch (err) {
        log(`     ⚠️ Attempt ${attempt} failed: ${err.message}`);
        if (attempt === MAX_ATTEMPTS_PER_PAGE) throw err;
        await delay(jitter(attempt * 2000)); // back off on non-429 failures too, not just 429s
      }
    }

    if (!success) throw new Error("Hit maximum rate limit retries. Giving up.");

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (err) {
      // Getting here means the request returned 200 but the body wasn't JSON —
      // almost always a bot-check/challenge page, not real data.
      throw new Error(`Response wasn't valid JSON (likely a block/challenge page): ${bodyText.slice(0, 200)}`);
    }

    // A missing positions array means the API shape changed; fail loudly instead of reporting 0 jobs
    if (!Array.isArray(data.data?.positions)) {
      throw new Error(`Unexpected API response on page ${page + 1}: no positions array`);
    }
    const positions = data.data.positions;

    if (page === 0) {
      totalJobsInAPI = data.data.count ?? null;
      log(`   API reports ${totalJobsInAPI ?? "?"} total jobs in India`);
    }

    if (positions.length === 0) break;

    for (const job of positions) {
      totalJobsChecked++;

      const daysSincePosted = getDaysSincePosted(job.postedTs, currentTime);
      const locationText = Array.isArray(job.locations) ? job.locations.join(" | ") : "";

      if (!isIndiaLocation(locationText)) {
        skipCounts.notIndia++;
        continue;
      }

      if (!isSoftwareJob(job.name, job.department)) {
        skipCounts.notSoftware++;
        continue;
      }

      matchingJobs.push({
        id: String(job.id),
        company: "Qualcomm",
        title: job.name,
        department: job.department || "N/A",
        location: locationText,
        daysSincePosted: daysSincePosted,
        url: `https://careers.qualcomm.com${job.positionUrl}`
      });
    }

    startOffset += positions.length;
    // Every page is read; stop once the API's own count is reached instead of paying for an empty page
    if (totalJobsInAPI !== null && startOffset >= totalJobsInAPI) break;
    if (page < MAX_PAGES_TO_FETCH - 1) await delay(jitter(DELAY_BETWEEN_PAGES_MS));
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

export async function main() {
  const startTime = Date.now();
  log(`Starting Qualcomm scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;
  let errorMessage = null;

  try {
    allJobs = await scrapeQualcomm();
    log(`✅ Qualcomm done`);
  } catch (error) {
    scrapeFailed = true;
    errorMessage = error.message;
    log(`❌ Qualcomm failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, jobIndex) => {
    const postedText = job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`;
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
