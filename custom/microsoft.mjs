// custom/microsoft.mjs | run: node custom/microsoft.mjs

const MAX_POSTING_AGE_DAYS = 7;
const MAX_PAGES_TO_FETCH = 40;
const REQUEST_TIMEOUT_MS = 20000;

const SOFTWARE_PATTERN =
  /\b(software|engineers?|engineering|technical|developers?|developer|sde|sdet|backend|back-end|frontend|front-end|full[- ]?stack|systems?|architect|ui|ux|react|node|java|c\+\+|typescript|mongo)\b/i;
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const jitter = base => base + Math.floor(Math.random() * base * 0.4);

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title, department) {
  return SOFTWARE_PATTERN.test(title || "") || SOFTWARE_PATTERN.test(department || "");
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

async function scrapeMicrosoft() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notSoftware: 0 };

  let startOffset = 0;
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
    "Referer": "https://apply.careers.microsoft.com/careers?domain=microsoft.com&location=India",
    "Origin": "https://apply.careers.microsoft.com",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-fetch-dest": "empty"
  };

  for (let page = 0; page < MAX_PAGES_TO_FETCH; page++) {
    log(`   Fetching page ${page + 1} (offset ${startOffset})...`);

    const apiUrl = `https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&location=India&start=${startOffset}&sort_by=recent`;

    let bodyText;
    let success = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        let response;
        ({ response, bodyText } = await fetchWithLogging(
          apiUrl,
          { headers: commonHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
          attempt
        ));

        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("retry-after");
          const cooldownMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : jitter(attempt * 3000);
          log(`     ⚠️ 429 Rate Limited. Cooling down for ${(cooldownMs / 1000).toFixed(1)}s...`);
          await delay(cooldownMs);
          continue;
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        success = true;
        break;
      } catch (err) {
        log(`     ⚠️ Attempt ${attempt} failed: ${err.message}`);
        if (attempt === 3) throw err;
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

    const positions = data.data?.positions || [];

    if (positions.length === 0) break;

    for (const job of positions) {
      totalJobsChecked++;

      const daysSincePosted = getDaysSincePosted(job.postedTs, currentTime);

      if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
        skipCounts.tooOld++;
        continue;
      }

      if (!isSoftwareJob(job.name, job.department)) {
        skipCounts.notSoftware++;
        continue;
      }

      matchingJobs.push({
        company: "Microsoft",
        title: job.name,
        department: job.department || "N/A",
        location: job.locations ? job.locations.join(" | ") : "India",
        daysSincePosted: daysSincePosted,
        url: `https://jobs.careers.microsoft.com${job.positionUrl}`
      });
    }

    startOffset += positions.length;
    if (page < MAX_PAGES_TO_FETCH - 1) await delay(jitter(2500));
  }

  log(`   Checked ${totalJobsChecked} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

async function main() {
  const startTime = Date.now();
  log(`Starting Microsoft scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapeMicrosoft();
    log(`✅ Microsoft done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ Microsoft failed: ${error.message}`);
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
