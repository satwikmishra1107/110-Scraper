import fs from "node:fs";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import { saveJobsAndGetNew } from "../store.mjs";

// --- Configuration Constants ---
const JOB_SEARCH_CRITERIA =
  "India (country-level location only) and software engineering / IT / technology job families";
const GEMINI_MODEL_VERSION = "gemini-3.5-flash-lite";

// Day-level dates only ("Posted Today" / "Posted Yesterday"): 1 = today + yesterday,
// which always covers a rolling 24h window. Overlap across hourly runs is fine —
// the DB dedupes on (company, job_id).
const MAX_POSTING_AGE_DAYS = 1;
const RESULTS_PER_PAGE = 20; // Workday max per page
const MAX_PAGES = 50; // hard ceiling so a bug can't loop forever
const STALE_PAGES_BEFORE_STOP = 2; // consecutive empty-of-recent pages before we stop
const REQUEST_TIMEOUT_MS = 30_000;
const FACET_CACHE_FILENAME = "./workday/workday-facets-cache.json";
// const RESULTS_OUTPUT_FILENAME = "./workday-jobs-output.json"; // temporary, until Supabase is wired up

// Load Companies from external JSON file
const COMPANIES = JSON.parse(fs.readFileSync("./workday/workday.json", "utf8"));

// --- Utility Functions ---
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// Load cache if it exists, otherwise start fresh
const facetCache = fs.existsSync(FACET_CACHE_FILENAME)
  ? JSON.parse(fs.readFileSync(FACET_CACHE_FILENAME, "utf8"))
  : {};

function saveFacetCache() {
  fs.writeFileSync(FACET_CACHE_FILENAME, JSON.stringify(facetCache, null, 2));
}

// ---------- Workday API Interaction ----------

async function fetchFromWorkdayApi(apiUrl, requestPayload) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    let response;
    try {
      response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // network drop / timeout — retry
      lastError = error;
      await delay(3000 * (attempt + 1));
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`HTTP ${response.status}`);
      await delay(3000 * (attempt + 1));
      continue;
    }

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${await response.text()}`);
      error.status = response.status;
      throw error; // not retryable (e.g. 400 = bad facet ids)
    }

    return response.json();
  }
  throw new Error(`Workday failed after 5 attempts: ${lastError?.message}`);
}

function calculateDaysSincePosting(postedDateString = "") {
  const lowerCaseDate = postedDateString.toLowerCase();
  if (lowerCaseDate.includes("today")) return 0;
  if (lowerCaseDate.includes("yesterday")) return 1;
  const daysMatch = lowerCaseDate.match(/(\d+)\+?\s*days?/);
  return daysMatch ? Number(daysMatch[1]) : Infinity;
}

// ---------- Data Processing & AI Facet Selection ----------

function flattenFacetTree(nodes, parentParameterName = null, flatList = []) {
  for (const node of nodes || []) {
    const parameterName = node.facetParameter || parentParameterName;
    if (node.id && node.descriptor && parameterName !== "locations") {
      flatList.push({
        parameterName,
        descriptorName: node.descriptor,
        id: node.id,
      });
    }
    flattenFacetTree(node.values, parameterName, flatList);
  }
  return flatList;
}

async function selectFacetsUsingAI(availableFacets) {
  const flattenedFacets = flattenFacetTree(availableFacets);

  const prompt =
    `Workday facets (parameterName, descriptorName, id):\n${JSON.stringify(flattenedFacets)}\n\n` +
    `Pick the facets that match: ${JOB_SEARCH_CRITERIA}.\n` +
    `Use only ids from the list above. Return ONLY a JSON object mapping parameterName to an array of ids, ` +
    `e.g. {"locationHierarchy1":["id1"],"jobFamilyGroup":["id2","id3"]}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_VERSION}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    },
  );

  if (!response.ok) throw new Error(`Gemini API Error ${response.status}`);

  const responseData = await response.json();
  const generatedText =
    responseData.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .join("") ?? "";
  const aiSelectedFacets = JSON.parse(
    generatedText.replace(/```json|```/g, "").trim(),
  );

  const validFacetIds = new Set(flattenedFacets.map((facet) => facet.id));
  const validatedFacets = {};

  for (const [paramName, ids] of Object.entries(aiSelectedFacets)) {
    const validIdsForParam = (Array.isArray(ids) ? ids : []).filter((id) =>
      validFacetIds.has(id),
    );
    if (validIdsForParam.length > 0)
      validatedFacets[paramName] = validIdsForParam;
  }

  if (!Object.keys(validatedFacets).length) {
    throw new Error(
      "No criteria match (e.g., Company has no India IT jobs today). AI found 0 matching facets.",
    );
  }
  return validatedFacets;
}

async function getOrResolveFacets(company) {
  if (!facetCache[company.name]) {
    // Only probe the API when we actually need to resolve facets (was probing every run before)
    const probeResponse = await fetchFromWorkdayApi(company.url, {
      limit: RESULTS_PER_PAGE,
      offset: 0,
    });
    console.log(
      `  └─ Asking AI to resolve facet mapping for ${company.name}...`,
    );
    facetCache[company.name] = await selectFacetsUsingAI(probeResponse.facets);
    saveFacetCache();
  }
  return facetCache[company.name];
}

// ---------- Normalizing output (same shape for every scraper, not just Workday) ----------

// Workday API url looks like: https://{host}/wday/cxs/{tenant}/{site}/jobs
// Public job url looks like:  https://{host}/{site}{externalPath}
function buildPublicJobUrl(apiUrl, externalPath) {
  const { origin, pathname } = new URL(apiUrl);
  const site = pathname.split("/")[4] ?? "";
  return `${origin}/${site}${externalPath}`;
}

function toNormalizedJob(company, posting, scrapedAt) {
  const daysAgo = calculateDaysSincePosting(posting.postedOn);
  return {
    source: "workday",
    company: company.name,
    job_id: posting.externalPath, // unique key together with `company`
    title: posting.title,
    location: posting.locationsText ?? null,
    url: buildPublicJobUrl(company.url, posting.externalPath),
    posted_label: posting.postedOn ?? null, // raw Workday text, e.g. "Posted Today"
    posted_date: Number.isFinite(daysAgo) // approximate, day-level only
      ? new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
      : null,
    scraped_at: scrapedAt,
  };
}

// ---------- Main Scraping Logic per Company ----------

async function scrapeCompany(company, scrapedAt, isRetry = false) {
  const appliedFacets = await getOrResolveFacets(company);
  const collectedJobs = [];
  let totalAvailableJobs = Infinity;
  let stalePages = 0;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * RESULTS_PER_PAGE;
      if (offset >= totalAvailableJobs) break;

      const jobData = await fetchFromWorkdayApi(company.url, {
        appliedFacets,
        limit: RESULTS_PER_PAGE,
        offset,
        searchText: "",
      });

      if (page === 0) totalAvailableJobs = jobData.total ?? 0;
      if (!jobData.jobPostings?.length) break;

      const recentJobsOnPage = jobData.jobPostings.filter(
        (job) =>
          job.externalPath &&
          calculateDaysSincePosting(job.postedOn) <= MAX_POSTING_AGE_DAYS,
      );
      collectedJobs.push(
        ...recentJobsOnPage.map((job) => toNormalizedJob(company, job, scrapedAt)),
      );

      stalePages = recentJobsOnPage.length ? 0 : stalePages + 1;
      if (stalePages >= STALE_PAGES_BEFORE_STOP) break;

      await delay(300);
    }
  } catch (error) {
    // A 400 usually means the company's facet IDs changed since we cached them.
    // Drop the cache entry and try exactly once more.
    if (error.status === 400 && !isRetry) {
      delete facetCache[company.name];
      saveFacetCache();
      return scrapeCompany(company, scrapedAt, true);
    }
    throw error;
  }

  return collectedJobs;
}

// ---------- Main Execution & Reporting ----------

export async function runAll() {
  console.log(
    `\nLoaded ${COMPANIES.length} companies from workday.json.\nStarting Job Scraper...\n`,
  );
  const scrapedAt = new Date().toISOString();
  const statusReport = [];
  const allRecentJobs = [];

  for (const company of COMPANIES) {
    console.log(`Processing: ${company.name}`);

    try {
      const jobs = await scrapeCompany(company, scrapedAt);
      allRecentJobs.push(...jobs);
      statusReport.push({
        company: company.name,
        ok: true,
        count: jobs.length,
        error: null,
      });
      console.log(`  └─ Success: Found ${jobs.length} recent jobs.\n`);
    } catch (error) {
      statusReport.push({
        company: company.name,
        ok: false,
        count: 0,
        error: error.message,
      });
      console.log(`  └─ Failed: ${error.message}\n`);
    }

    await delay(1000);
  }

  return { source: "workday", scraped_at: scrapedAt, jobs: allRecentJobs, report: statusReport };
}

// Run standalone: `node workday.mjs`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runAll();

  console.log("=== FINAL EXECUTION REPORT ===");
  console.table(result.report);
  console.log(`\nTotal jobs collected across all working platforms: ${result.jobs.length}\n`);

  // Print the actual job data (not just counts) so you can see it before Supabase is wired up
  // console.log("=== JOBS (JSON) ===");
  // console.log(JSON.stringify(result.jobs, null, 2));

  // Also save it to a file so you can inspect/diff it between runs
  // fs.writeFileSync(RESULTS_OUTPUT_FILENAME, JSON.stringify(result, null, 2));
  // console.log(`\nSaved full result to ${RESULTS_OUTPUT_FILENAME}`);

  const newJobs = await saveJobsAndGetNew(result.jobs);
  console.log(`\n=== NEW JOBS (not seen before): ${newJobs.length} ===`);
  // console.table(newJobs.map(({ company, title, location, url }) => ({ company, title, location, url })));

  if (result.report.every((r) => !r.ok)) process.exitCode = 1; // let a scheduler see total failure
}