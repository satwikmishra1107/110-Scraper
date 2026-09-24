// find-ats-with-browser.mjs | run: node find-ats-with-browser.mjs

import { chromium } from "playwright";

// Paste the same careers page links you used in the first probe
const COMPANY_CAREER_PAGES = {
  Chargebee: "https://jobs.chargebee.com/",
  Zoomcar: "https://www.zoomcar.com/careers",
  Zoho: "https://www.zoho.com/careers/",
  Siemens: "https://jobs.siemens.com/en_US/externaljobs/Home",
  "Shaadi.com": "https://careers.peopleinteractive.in/",
  Practo: "https://www.practo.com/company/careers",
  OnePlus: "https://www.oneplus.com/us/careers",
  McKinsey: "https://www.mckinsey.com/in/careers-in-india",
  Lenovo: "https://jobs.lenovo.com/en_US/careers",
  HSBC: "https://portal.careers.hsbc.com/careers",
  EXL: "https://www.exlservice.com/careers",
  Cleartrip: "https://careers.cleartrip.com/",
  CarDekho: "https://careers.cardekho.com/",
  ByteDance: "https://joinbytedance.com/",
  AMD: "https://careers.amd.com/",
  Airtel: "https://www.airtel.in/careers",
  "Twitter/X": "https://x.ai/careers",
  UST: "https://www.ust.com/en/careers",
  "Cure.fit": "https://careers.cult.fit/cult/",
  "Springer Nature": "https://group.springernature.com/gp/group/careers",
  boAt: "https://www.boat-lifestyle.com/pages/boat-careers",
  FirstCry: "https://www.firstcry.com/careers/",
  LeadSquared: "https://www.leadsquared.com/careers/",
  UpGrad: "https://careers.upgrad.com/",
  Nykaa: "https://www.nykaa.com/who_are_we",
  Lenskart: "https://hiring.lenskart.com/",
  Cisco: "https://careers.cisco.com/global/en",
  CoinSwitch: "https://recruiterflow.com/coinswitch/jobs",
  PolicyBazaar: "https://www.policybazaar.com/careers/",
  Cars24: "https://www.cars24.com/careers/",
  Quikr: "https://insurance.quikr.com/html/jobs.php",
  BigBasket: "https://careers.bigbasket.com/",
  PharmEasy: "https://pharmeasy.in/careers/",
  "Pine Labs": "https://www.pinelabs.com/careers",
  Upstox: "https://upstox.com/careers/",
  Zerodha: "https://careers.zerodha.com/",
  Delhivery: "https://careers.delhivery.com/",
  OYO: "https://www.oyorooms.com/careers",
  "Urban Company": "https://careers.urbancompany.com/",
  Snapdeal: "https://www.snapdeal.com/info/careers",
  Oracle: "https://www.oracle.com/careers/",
  Ola: "https://www.olacabs.com/careers",
  Acko: "https://www.acko.com/careers/",
  MakeMyTrip: "https://careers.makemytrip.com/",
  BharatPe: "https://www.bharatpe.com/career",
  Slack: "https://slack.com/intl/en-in/careers",
  Rippling: "https://www.rippling.com/en-IN/careers",
  "Media.net": "https://careers.media.net/",
  "D.E. Shaw": "https://www.deshaw.com/careers",
  Flipkart: "https://www.flipkartcareers.com/",
  "Goldman Sachs": "https://www.goldmansachs.com/careers",
  Uber: "https://jobs.uber.com/en/",
  Zepto: "https://www.zepto.com/s/careers",
  Blinkit: "https://www.eternal.com/careers/",
  "JP Morgan": "https://www.jpmorganchase.com/careers",
  HashiCorp: "https://www.hashicorp.com/en/careers",
  Atlassian: "https://www.atlassian.com/company/careers",
};

const PAGE_LOAD_TIMEOUT_MS = 45000;
const EXTRA_WAIT_AFTER_LOAD_MS = 4000; // some sites load jobs a few seconds after the page opens
const MAX_JOB_LIST_CANDIDATES_TO_PRINT = 5;

// If any request the page makes matches one of these, we know the hiring system
const KNOWN_HIRING_SYSTEMS = {
  workday: /myworkdayjobs\.com/i,
  greenhouse: /greenhouse\.io/i,
  lever: /lever\.co/i,
  ashby: /ashbyhq\.com/i,
  smartrecruiters: /smartrecruiters\.com/i,
  oracleHcm: /hcmRestApi|hcmUI\/CandidateExperience/i,
  eightfold: /eightfold\.ai|\/api\/pcsx|\/api\/apply\/v2/i,
  avature: /avature/i,
  phenom: /phenompeople/i,
  successFactors: /successfactors|jobs2web/i,
  icims: /icims\.com/i,
  workable: /workable\.com/i,
  darwinbox: /darwinbox/i,
  keka: /keka(hire)?\.com/i,
  zohoRecruit: /zohorecruit/i,
  freshteam: /freshteam\.com/i,
  recruitee: /recruitee\.com/i,
  taleo: /taleo\.net/i,
  getro: /getro\.com/i,
};

// Words that usually appear in the address of a job list request
const JOB_LIST_URL_HINTS =
  /job|career|position|requisition|opening|vacanc|listing/i;

// Ignore tracking and analytics requests, they are never the job list
const IGNORED_HOSTS =
  /google|doubleclick|facebook|linkedin|clarity|hotjar|segment|mixpanel|sentry|newrelic|cloudflareinsights|onetrust|cookielaw/i;

async function inspectOneCompany(browser, companyName, careersPageUrl) {
  const browserPage = await browser.newPage();

  const hiringSystemsFound = new Set();
  const jobListCandidateUrls = new Set();

  // Runs every time the page receives a response from any server
  browserPage.on("response", (response) => {
    const requestUrl = response.url();
    if (IGNORED_HOSTS.test(requestUrl)) return;

    for (const [systemName, pattern] of Object.entries(KNOWN_HIRING_SYSTEMS)) {
      if (pattern.test(requestUrl)) hiringSystemsFound.add(systemName);
    }

    const contentType = response.headers()["content-type"] || "";
    const isJsonResponse = contentType.includes("json");

    if (isJsonResponse && JOB_LIST_URL_HINTS.test(requestUrl)) {
      jobListCandidateUrls.add(`${response.request().method()} ${requestUrl}`);
    }
  });

  try {
    await browserPage.goto(careersPageUrl, {
      waitUntil: "networkidle",
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });
    await browserPage.waitForTimeout(EXTRA_WAIT_AFTER_LOAD_MS);

    // The page may have redirected to the hiring system, so check the final address too
    const finalPageUrl = browserPage.url();
    for (const [systemName, pattern] of Object.entries(KNOWN_HIRING_SYSTEMS)) {
      if (pattern.test(finalPageUrl)) hiringSystemsFound.add(systemName);
    }
  } catch (error) {
    console.log(
      `⚠️  ${companyName}: page did not fully load (${error.message})`,
    );
  }

  await browserPage.close();

  return {
    companyName,
    hiringSystems: [...hiringSystemsFound],
    jobListCandidates: [...jobListCandidateUrls].slice(
      0,
      MAX_JOB_LIST_CANDIDATES_TO_PRINT,
    ),
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  for (const [companyName, careersPageUrl] of Object.entries(
    COMPANY_CAREER_PAGES,
  )) {
    const result = await inspectOneCompany(
      browser,
      companyName,
      careersPageUrl,
    );

    console.log(`\n=== ${result.companyName} ===`);
    console.log(
      "Hiring system:",
      result.hiringSystems.length
        ? result.hiringSystems.join(", ")
        : "none recognised (custom)",
    );

    if (result.jobListCandidates.length > 0) {
      console.log("Requests that may be the job list:");
      result.jobListCandidates.forEach((candidate) =>
        console.log("  ", candidate),
      );
    } else {
      console.log(
        "No job list request found. Try opening the site by hand and search for a job.",
      );
    }
  }

  await browser.close();
}

await main();
