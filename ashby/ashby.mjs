// ashby.mjs | run: node ashby.mjs
import fs from "node:fs";

const COMPANIES_FILE = "./ashby/ashby.json";
const MAX_POSTING_AGE_DAYS = 7;
const NOW = Date.now();

const INDIA_LOCATIONS = [
  "india", "bengaluru", "bangalore", "hyderabad", 
  "mumbai", "pune", "gurgaon", "noida", "delhi", "chennai", "remote"
];

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
  "c++",
  "typescript",
  "mongo",
];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const COMPANIES = JSON.parse(fs.readFileSync(COMPANIES_FILE, "utf8"));

function isIndiaLocation(locationName) {
  if (!locationName) return false;
  const locLower = locationName.toLowerCase();
  if (INDIA_LOCATIONS.some(city => locLower.includes(city) && city !== "remote")) return true;
  if (locLower.includes("remote") && locLower.includes("india")) return true;
  return false;
}

function isSoftwareDomain(title, department) {
  const titleLower = (title || "").toLowerCase();
  const deptLower = (department || "").toLowerCase();
  if (SD_KEYWORDS.some(kw => titleLower.includes(kw))) return true;
  if (deptLower.includes("engineering") || deptLower.includes("infrastructure")) return true;
  return false;
}

async function scrapeAshby(companyObj) {
  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${companyObj.slug}?includeCompensation=true`;
  
  const response = await fetch(apiUrl, { headers: { "Accept": "application/json" } });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} - Invalid slug`);
  }

  const data = await response.json();
  const jobs = data.jobs || [];
  const recentIndiaTechJobs = [];

  for (const job of jobs) {
    if (!job.isListed) continue; // Skip hidden/internal jobs
      
    const location = job.location || "Unknown";
    const department = job.department || "N/A";

    if (!isIndiaLocation(location)) continue;
    if (!isSoftwareDomain(job.title, department)) continue;

    const publishedDate = new Date(job.publishedAt);
    const daysAgo = Math.floor((NOW - publishedDate.getTime()) / (1000 * 60 * 60 * 24));

    if (daysAgo <= MAX_POSTING_AGE_DAYS) {
      recentIndiaTechJobs.push({
        company: companyObj.company,
        title: job.title,
        department: department,
        location: location,
        daysAgo: daysAgo === 0 ? "Today" : `${daysAgo} days ago`,
        url: job.jobUrl
      });
    }
  }
  return recentIndiaTechJobs;
}

async function runAll() {
  console.log(`\nLoaded ${COMPANIES.length} companies from Ashby.`);
  console.log(`Starting Ashby Scraper...\n`);
  
  const statusReport = [];
  const allRecentJobs = [];

  for (const company of COMPANIES) {
    console.log(`Processing: ${company.company}`);
    
    try {
      const jobs = await scrapeAshby(company);
      allRecentJobs.push(...jobs);
      
      statusReport.push({ Company: company.company, Status: "✅ Success", "India SD Jobs": jobs.length });
      console.log(`  └─ Success: Found ${jobs.length} recent India SD jobs.\n`);
    } catch (error) {
      statusReport.push({ Company: company.company, Status: "❌ Failed", "India SD Jobs": 0 });
      console.log(`  └─ Failed: ${error.message}\n`);
    }
    await delay(500); 
  }

  console.log("=== FINAL ASHBY REPORT ===");
  console.table(statusReport);

  if (allRecentJobs.length > 0) {
    console.log("\n=== RECENT INDIA TECH JOBS ===");
    allRecentJobs.forEach((job, index) => {
      console.log(`${index + 1}. [${job.company}] ${job.title} (${job.department})`);
      console.log(`   Location: ${job.location} | Posted: ${job.daysAgo}`);
      console.log(`   Link: ${job.url}\n`);
    });
  } else {
    console.log("\nNo recent tech jobs found matching the criteria.");
  }
}

runAll();