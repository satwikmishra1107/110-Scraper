// custom/run-all.mjs | run: node custom/run-all.mjs (from the repo root)
// Runs every custom scraper one after another, then saves exactly like ats-common's runStandalone():
// jobs → saveJobsAndGetNew(), new/updated → Telegram, one "custom" row → runs table.
import "dotenv/config";
import { saveJobsAndGetNew, saveRun } from "../store.mjs";
import { sendTelegramAlerts } from "../telegram.mjs";

const SOURCE = "custom";
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// Each file and the company name(s) its jobs use. The names must match job.company exactly,
// because saveRun() attaches new/updated counts to report entries by company name.
const CUSTOM_SCRAPERS = [
  { file: "airtel.mjs", companies: ["Airtel (Bharti)"] },
  { file: "amazon.mjs", companies: ["Amazon"] },
  { file: "amd.mjs", companies: ["AMD"] },
  { file: "apple.mjs", companies: ["Apple"] },
  { file: "atlassian.mjs", companies: ["Atlassian"] },
  { file: "delhivery.mjs", companies: ["Delhivery"] },
  { file: "EXLandJPMorgan.mjs", companies: ["JPMorgan", "EXL"] },
  { file: "flipkart.mjs", companies: ["Flipkart"] },
  { file: "google.mjs", companies: ["Google"] },
  { file: "hsbc.mjs", companies: ["HSBC"] },
  { file: "lenskart.mjs", companies: ["Lenskart"] },
  { file: "makemytrip.mjs", companies: ["MakeMyTrip"] },
  { file: "meta.mjs", companies: ["Meta"] },
  { file: "microsoft.mjs", companies: ["Microsoft"] },
  { file: "myntra.mjs", companies: ["Myntra"] },
  { file: "netapp.mjs", companies: ["NetApp"] },
  { file: "netflix.mjs", companies: ["Netflix"] },
  { file: "oracle.mjs", companies: ["Oracle"] },
  { file: "phonepe.mjs", companies: ["PhonePe"] },
  { file: "postman.mjs", companies: ["Postman"] },
  { file: "qualcomm.mjs", companies: ["Qualcomm"] },
  { file: "rippling.mjs", companies: ["Rippling"] },
  { file: "zoho.mjs", companies: ["Zoho"] },
];

// Custom scrapers give "days since posted", not a raw date, so the date is worked out from the run time.
// null (Google, Meta, Zoho without a date) stays null: those jobs are deduped by job_id only.
function toPostedDate(daysSincePosted, scrapedAt) {
  if (typeof daysSincePosted !== "number") return null;
  const postedTime = Date.parse(scrapedAt) - daysSincePosted * MILLISECONDS_PER_DAY;
  return new Date(postedTime).toISOString().slice(0, 10);
}

function toPostedLabel(daysSincePosted) {
  if (typeof daysSincePosted !== "number") return "Date not shown";
  if (daysSincePosted <= 0) return "Posted Today";
  return `Posted ${daysSincePosted} Day${daysSincePosted === 1 ? "" : "s"} Ago`;
}

// Same columns as ats-common's toRow(), so saveJobsAndGetNew() treats these like any other source.
function toRow(job, scrapedAt) {
  return {
    source: SOURCE,
    company: job.company,
    job_id: job.id,
    title: job.title,
    location: job.location || null,
    url: job.url,
    posted_label: toPostedLabel(job.daysSincePosted),
    posted_date: toPostedDate(job.daysSincePosted, scrapedAt),
    scraped_at: scrapedAt,
  };
}

// Runs one file's main() and turns its result into one report entry per company.
async function runOneScraper(scraperConfig, scrapedAt) {
  try {
    // Loaded here, not at the top: a broken file becomes one failed entry instead of crashing the whole runner
    const scraperModule = await import(`./${scraperConfig.file}`);
    const { allJobs, scrapeFailed, errorMessage } = await scraperModule.main();

    // A job with no id can't be deduped, so it's dropped and reported instead of saved as "undefined"
    const jobsWithId = allJobs.filter((job) => job.id && job.id !== "undefined");
    const jobsWithoutIdCount = allJobs.length - jobsWithId.length;

    const unknownCompanies = [...new Set(jobsWithId.map((job) => job.company))]
      .filter((company) => !scraperConfig.companies.includes(company));
    if (unknownCompanies.length > 0) {
      console.warn(`⚠️ ${scraperConfig.file} returned companies not in CUSTOM_SCRAPERS: ${unknownCompanies.join(", ")}`);
    }

    const warnings = [];
    if (jobsWithoutIdCount > 0) warnings.push(`${jobsWithoutIdCount} jobs had no id and were skipped`);

    const reportEntries = scraperConfig.companies.map((company) => ({
      company,
      file: scraperConfig.file,
      ok: !scrapeFailed,
      count: jobsWithId.filter((job) => job.company === company).length,
      error: [errorMessage, ...warnings].filter(Boolean).join(" | ") || null,
    }));

    return { rows: jobsWithId.map((job) => toRow(job, scrapedAt)), reportEntries };
  } catch (loadError) {
    // The file itself is broken (syntax error, missing package), so main() never ran
    const reportEntries = scraperConfig.companies.map((company) => ({
      company,
      file: scraperConfig.file,
      ok: false,
      count: 0,
      error: `Could not load or run file: ${loadError.message}`,
    }));
    return { rows: [], reportEntries };
  }
}

async function runAllCustomScrapers() {
  const scrapedAt = new Date().toISOString();
  const allRows = [];
  const report = [];

  // One file at a time: several of these launch Chromium, and running them together can run out of memory
  for (const scraperConfig of CUSTOM_SCRAPERS) {
    console.log(`\n########## ${scraperConfig.file} ##########`);
    const { rows, reportEntries } = await runOneScraper(scraperConfig, scrapedAt);
    allRows.push(...rows);
    report.push(...reportEntries);
  }

  console.log(`\n=== FINAL ${SOURCE.toUpperCase()} REPORT ===`);
  console.table(report);
  console.log(`\nTotal jobs collected: ${allRows.length}\n`);

  const newJobs = await saveJobsAndGetNew(allRows);
  console.log(`\n=== NEW JOBS (not seen before): ${newJobs.length} ===`);

  await sendTelegramAlerts(SOURCE, newJobs);
  await saveRun(SOURCE, report, newJobs);

  // Same rule as the ATS scrapers: only fail the workflow step when every company failed
  if (report.length && report.every((reportEntry) => !reportEntry.ok)) process.exitCode = 1;
}

await runAllCustomScrapers();
