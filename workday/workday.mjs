import fs from "node:fs";
import "dotenv/config";

// --- Configuration Constants ---
const JOB_SEARCH_CRITERIA =
  "India (country-level location only) and software engineering / IT / technology job families";
const GEMINI_MODEL_VERSION = "gemini-3.5-flash-lite";

const MAX_POSTING_AGE_DAYS = 7;
const RESULTS_PER_PAGE = 20;
const FACET_CACHE_FILENAME = "./workday/workday-facets-cache.json";

// Load Companies from external JSON file
const COMPANIES = JSON.parse(fs.readFileSync("./workday/workday.json", "utf8"));

// --- Utility Functions ---
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// Load cache if it exists, otherwise start fresh
const facetCache = fs.existsSync(FACET_CACHE_FILENAME)
  ? JSON.parse(fs.readFileSync(FACET_CACHE_FILENAME, "utf8"))
  : {};

// ---------- Workday API Interaction ----------

async function fetchFromWorkdayApi(apiUrl, requestPayload) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestPayload),
    });

    if (response.status === 429) {
      const waitTime = 3000 * (attempt + 1);
      await delay(waitTime);
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }
  throw new Error("Too many 429 rate limit errors from Workday.");
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
    const validIdsForParam = (ids || []).filter((id) => validFacetIds.has(id));
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

async function getOrResolveFacets(companyName, availableFacets) {
  if (!facetCache[companyName]) {
    console.log(
      `  └─ Asking AI to resolve facet mapping for ${companyName}...`,
    );
    facetCache[companyName] = await selectFacetsUsingAI(availableFacets);

    // Only saves to workday_assets.json if the AI succeeded above
    fs.writeFileSync(FACET_CACHE_FILENAME, JSON.stringify(facetCache, null, 2));
  }
  return facetCache[companyName];
}

// ---------- Main Scraping Logic per Company ----------

async function scrapeCompany(company) {
  const initialProbeResponse = await fetchFromWorkdayApi(company.url, {
    limit: RESULTS_PER_PAGE,
    offset: 0,
  });

  const appliedFacets = await getOrResolveFacets(
    company.name,
    initialProbeResponse.facets,
  );
  const collectedJobs = [];
  let totalAvailableJobs = Infinity;

  for (
    let offset = 0;
    offset < totalAvailableJobs;
    offset += RESULTS_PER_PAGE
  ) {
    const jobData = await fetchFromWorkdayApi(company.url, {
      appliedFacets,
      limit: RESULTS_PER_PAGE,
      offset,
      searchText: "",
    });

    if (offset === 0) totalAvailableJobs = jobData.total ?? 0;

    if (!jobData.jobPostings?.length) break;

    const recentJobsOnPage = jobData.jobPostings.filter(
      (job) => calculateDaysSincePosting(job.postedOn) <= MAX_POSTING_AGE_DAYS,
    );
    collectedJobs.push(...recentJobsOnPage);

    if (recentJobsOnPage.length === 0) break;

    await delay(300);
  }

  return collectedJobs;
}

// ---------- Main Execution & Reporting ----------

async function runAll() {
  console.log(
    `\nLoaded ${COMPANIES.length} companies from workday.json.\nStarting Job Scraper...\n`,
  );
  const statusReport = [];
  const allRecentJobs = [];

  for (const company of COMPANIES) {
    console.log(`Processing: ${company.name}`);

    try {
      const jobs = await scrapeCompany(company);

      allRecentJobs.push(
        ...jobs.map((j) => ({
          company: company.name,
          title: j.title,
          date: j.postedOn,
        })),
      );
      statusReport.push({
        Company: company.name,
        Status: "✅ Success",
        "Jobs Found": jobs.length,
        Details: "OK",
      });
      console.log(`  └─ Success: Found ${jobs.length} recent jobs.\n`);
    } catch (error) {
      statusReport.push({
        Company: company.name,
        Status: "❌ Failed",
        "Jobs Found": 0,
        Details: error.message.substring(0, 60) + "...",
      });
      console.log(`  └─ Failed: ${error.message}\n`);
    }

    await delay(1000);
  }

  // Final Output
  console.log("=== FINAL EXECUTION REPORT ===");
  console.table(statusReport);
  console.log(
    `\nTotal jobs collected across all working platforms: ${allRecentJobs.length}\n`,
  );
}

runAll();
