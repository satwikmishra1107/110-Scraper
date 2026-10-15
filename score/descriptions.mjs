// score/descriptions.mjs — a job's full description, read from its platform's public API.
// The five ATS platforms, plus the custom sites (custom/*.mjs) that have an API. Not yet: the sites scraped
// in a browser (Google, Meta, Airtel, Delhivery, Flipkart). Their jobs have no description, and so no score.
import { fetchJson, loadCompanies } from "../ats-common.mjs";

const MAX_DESCRIPTION_CHARS = 20_000; // a few very long postings repeat the same boilerplate; this is plenty

// Each scraper's company list: maps the stored company name back to its API address / slug.
// Read on first use, not at import: telegram.mjs imports this file while ats-common.mjs is still loading.
const COMPANY_LIST_FILES = {
  workday: "./workday/workday.json", // { name, url }
  greenhouse: "./greenhouse/greenhouse.json", // { company, slug }
  lever: "./lever/lever.json",
  ashby: "./ashby/ashby.json",
  smartrecruiters: "./smartrecruiters/smartrecruiters.json",
};
const companyLists = {};

function findCompany(source, companyName) {
  companyLists[source] ??= loadCompanies(COMPANY_LIST_FILES[source]);
  const nameField = source === "workday" ? "name" : "company";
  const company = companyLists[source].find((listedCompany) => listedCompany[nameField] === companyName);
  if (!company) throw new Error(`${companyName} is no longer in ${source}.json`);
  return company;
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", bull: "•", middot: "·",
};

// "&lt;p&gt;Java &amp; Go&#43;" → "<p>Java & Go+"
function decodeHtmlEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] !== "#") return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
    const codePoint = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
}

// "<p>We use:</p><ul><li>Java</li><li>Go</li></ul>" → "We use:\n- Java\n- Go"
export function htmlToText(html) {
  if (!html) return "";
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|ul|ol|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// "Heading\nbody" for each section that has a body, as one text. A section repeated word for word appears once.
function joinSections(sections) {
  const texts = new Set();
  for (const [heading, html] of sections) {
    const body = htmlToText(html);
    if (body) texts.add(heading ? `${heading}\n${body}` : body);
  }
  return [...texts].join("\n\n");
}

// Sites with no one-job endpoint: their job list (descriptions included) is read once per run and reused.
// loadList() returns a Map of job id → posting.
const jobLists = new Map();

async function findInJobList(listName, loadList, jobId) {
  if (!jobLists.has(listName)) jobLists.set(listName, loadList());
  const posting = (await jobLists.get(listName)).get(String(jobId));
  if (!posting) throw new Error("no longer on the company's job list");
  return posting;
}

/** Every posting from a paged list API: fetchPage(1), fetchPage(2), … until a page comes back short. */
async function readAllPages(fetchPage, pageSize, maxPages = 20) {
  const postings = [];
  for (let page = 1; page <= maxPages; page++) {
    const pagePostings = await fetchPage(page);
    postings.push(...pagePostings);
    if (pagePostings.length < pageSize) break;
  }
  return postings;
}

// Sections: companyDescription (skipped, it's the same for every job), jobDescription, qualifications, additionalInformation
async function fetchSmartRecruitersPosting(slug, postingId) {
  const data = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings/${postingId}`);
  const sections = data.jobAd?.sections ?? {};
  return ["jobDescription", "qualifications", "additionalInformation"]
    .map((sectionName) => sections[sectionName])
    .filter((section) => section?.text)
    .map((section) => `${section.title ?? ""}\n${htmlToText(section.text)}`.trim())
    .join("\n\n");
}

const DESCRIPTION_FETCHERS = {
  // job_id is the job's path, e.g. "/job/Pune-India/Software-Engineer_R-123"; the API lives next to the list URL
  async workday(job) {
    const { url } = findCompany("workday", job.company);
    const data = await fetchJson(url.replace(/\/jobs$/, "") + job.job_id);
    return htmlToText(data.jobPostingInfo?.jobDescription);
  },

  // `content` is HTML with its tags escaped ("&lt;p&gt;"), so it's decoded once before the tags come off
  async greenhouse(job) {
    const { slug } = findCompany("greenhouse", job.company);
    const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${job.job_id}`);
    return htmlToText(decodeHtmlEntities(data.content ?? ""));
  },

  // The posting is split up: an opening, the body, lists ("Requirements", …) and a closing.
  // Some postings leave the *Plain fields empty and fill only the HTML ones.
  async lever(job) {
    const { slug } = findCompany("lever", job.company);
    const data = await fetchJson(`https://api.lever.co/v0/postings/${slug}/${job.job_id}`);
    const body = data.descriptionBodyPlain || data.descriptionPlain || htmlToText(data.descriptionBody || data.description);
    const lists = (data.lists ?? []).map((list) => `${list.text}\n${htmlToText(list.content)}`);
    return [data.openingPlain, body, ...lists, data.additionalPlain || htmlToText(data.additional)]
      .filter(Boolean)
      .join("\n\n");
  },

  async ashby(job) {
    const { slug } = findCompany("ashby", job.company);
    const posting = await findInJobList(
      `ashby:${slug}`,
      async () => {
        const board = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
        return new Map((board.jobs ?? []).map((boardJob) => [boardJob.id, boardJob]));
      },
      job.job_id,
    );
    return posting.descriptionPlain || htmlToText(posting.descriptionHtml);
  },

  async smartrecruiters(job) {
    const { slug } = findCompany("smartrecruiters", job.company);
    return fetchSmartRecruitersPosting(slug, job.job_id);
  },
};

// ---- Custom sites ----

// Some custom sites turn away requests that don't look like they come from a browser
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};
const fetchFromSite = (url, headers = {}) => fetchJson(url, { headers: { ...BROWSER_HEADERS, ...headers } });

// Eightfold career sites: HSBC, NetApp, Netflix
const eightfold = (host, domain) => async (job) => {
  const data = await fetchFromSite(`https://${host}/api/apply/v2/jobs/${job.job_id}?domain=${domain}`);
  return htmlToText(data.job_description);
};

// Eightfold's newer "pcsx" sites: Microsoft, Qualcomm
const eightfoldPcsx = (host, domain) => async (job) => {
  const data = await fetchFromSite(
    `https://${host}/api/pcsx/position_details?position_id=${job.job_id}&domain=${domain}&hl=en`,
  );
  return htmlToText(data.data?.jobDescription);
};

// Oracle Recruiting Cloud: JPMorgan, EXL, Oracle. A closed job comes back as an empty list, not a 404.
// The corporate description is skipped, it's the same for every job.
const oracleRecruiting = (host, siteNumber) => async (job) => {
  const data = await fetchFromSite(
    `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails` +
      `?expand=all&onlyData=true&finder=ById;Id=%22${job.job_id}%22,siteNumber=${siteNumber}`,
  );
  const requisition = data.items?.[0];
  if (!requisition) throw new Error("no longer posted");
  return joinSections([
    ["", requisition.ExternalDescriptionStr],
    ["Responsibilities", requisition.ExternalResponsibilitiesStr],
    ["Qualifications", requisition.ExternalQualificationsStr],
  ]);
};

// Custom jobs all have source "custom", so the fetcher is picked by company (the names in custom/run-all.mjs)
const CUSTOM_DESCRIPTION_FETCHERS = {
  // No one-job endpoint, but searching for the job's id finds just that job
  async Amazon(job) {
    const data = await fetchFromSite(`https://www.amazon.jobs/en/search.json?base_query=${job.job_id}&result_limit=10`);
    const posting = (data.jobs ?? []).find((found) => String(found.id_icims || found.id) === job.job_id);
    if (!posting) throw new Error("no longer on amazon.jobs");
    return joinSections([
      ["", posting.description],
      ["Basic qualifications", posting.basic_qualifications],
      ["Preferred qualifications", posting.preferred_qualifications],
    ]);
  },

  // `description` already includes the responsibilities; `qualifications` is the same benefits text on every job
  async AMD(job) {
    const posting = await findInJobList(
      "AMD",
      async () => {
        const postings = await readAllPages(async (page) => {
          const data = await fetchFromSite(
            `https://careers.amd.com/api/jobs?country=India&page=${page}&categories=Engineering` +
              `&sortBy=posted_date&limit=100&descending=true&internal=false`,
          );
          return (data.jobs ?? []).map((listedJob) => listedJob.data).filter(Boolean);
        }, 100);
        return new Map(postings.map((listedJob) => [String(listedJob.req_id), listedJob]));
      },
      job.job_id,
    );
    return htmlToText(posting.description);
  },

  async Apple(job) {
    const data = await fetchFromSite(`https://jobs.apple.com/api/v1/jobDetails/${job.job_id}?locale=en-in`);
    const posting = data.res ?? {};
    return joinSections([
      ["", posting.jobSummary],
      ["Description", posting.description],
      ["Responsibilities", posting.responsibilities],
      ["Minimum qualifications", posting.minimumQualifications],
      ["Preferred qualifications", posting.preferredQualifications],
    ]);
  },

  async Atlassian(job) {
    const posting = await findInJobList(
      "Atlassian",
      async () => {
        const jobs = await fetchFromSite("https://www.atlassian.com/endpoint/careers/listings");
        return new Map(jobs.map((listedJob) => [String(listedJob.id), listedJob]));
      },
      job.job_id,
    );
    return joinSections([
      ["", posting.overview],
      ["Responsibilities", posting.responsibilities],
      ["Qualifications", posting.qualifications],
    ]);
  },

  EXL: oracleRecruiting("fa-ewjt-saasfaprod1.fa.ocs.oraclecloud.com", "CX_2"),
  HSBC: eightfold("portal.careers.hsbc.com", "hsbc.com"),
  JPMorgan: oracleRecruiting("jpmc.fa.oraclecloud.com", "CX_1001"),

  async Lenskart(job) {
    const posting = await findInJobList(
      "Lenskart",
      async () => {
        const data = await fetchFromSite("https://ainterviews.com/api/job_board/lenskart_ho/jobs/");
        return new Map((data.jobs ?? []).map((listedJob) => [String(listedJob.id), listedJob]));
      },
      job.job_id,
    );
    return htmlToText(posting.description);
  },

  Microsoft: eightfoldPcsx("apply.careers.microsoft.com", "microsoft.com"),

  // `aboutCompany` is skipped, it's the same for every job
  async Myntra(job) {
    const posting = await findInJobList(
      "Myntra",
      async () => {
        const postings = await readAllPages(async (page) => {
          const data = await fetchFromSite(
            `https://io.spire2grow.com/ies/v1/p/requisition/_search?page=${page}&size=50` +
              `&selectedSortOrder=desc&selectedSortField=postedOn`,
            { workspaceid: "MYNTRA-93as3" },
          );
          return data.entities ?? [];
        }, 50);
        return new Map(postings.map((listedJob) => [String(listedJob.id), listedJob]));
      },
      job.job_id,
    );
    return htmlToText(posting.jobDescription);
  },

  NetApp: eightfold("netapp.eightfold.ai", "netapp.com"),
  Netflix: eightfold("explore.jobs.netflix.net", "netflix.com"),
  Oracle: oracleRecruiting("eeho.fa.us2.oraclecloud.com", "CX_45001"),

  // job_id is the SmartRecruiters page, e.g. "https://jobs.smartrecruiters.com/PHONEPELIMITED/1000000000003901-software-engineer"
  async PhonePe(job) {
    const [, slug, postingId] = job.job_id.match(/smartrecruiters\.com\/([^/]+)\/(\d+)/) ?? [];
    if (!postingId) throw new Error("job_id is not a SmartRecruiters link");
    return fetchSmartRecruitersPosting(slug, postingId);
  },

  // url is the Workday page, e.g. https://postman.wd108.myworkdayjobs.com/careers/job/Bangalore-India/…_JR1000061;
  // the same path under /wday/cxs/<tenant> is its API
  async Postman(job) {
    const pageUrl = new URL(job.url);
    const tenant = pageUrl.hostname.split(".")[0];
    const jobPath = pageUrl.pathname.replace(/^\/[a-z]{2}-[A-Z]{2}(?=\/)/, ""); // drop a "/en-US" prefix
    const data = await fetchFromSite(`${pageUrl.origin}/wday/cxs/${tenant}${jobPath}`);
    return htmlToText(data.jobPostingInfo?.jobDescription);
  },

  Qualcomm: eightfoldPcsx("careers.qualcomm.com", "qualcomm.com"),

  // description.company is skipped, it's the same for every job
  async Rippling(job) {
    const data = await fetchFromSite(`https://ats.rippling.com/api/v2/board/rippling/jobs/${job.job_id}`);
    return htmlToText(data.description?.role);
  },
};

const getDescriptionFetcher = (job) =>
  job.source === "custom" ? CUSTOM_DESCRIPTION_FETCHERS[job.company] : DESCRIPTION_FETCHERS[job.source];

export const SOURCES_WITH_DESCRIPTIONS = [...Object.keys(DESCRIPTION_FETCHERS), "custom"];

/** Whether this job's description can be read at all (not every custom site has a fetcher). */
export const canFetchDescription = (job) => Boolean(getDescriptionFetcher(job));

/** The job's description as plain text. Throws if the platform has none or the request fails. */
export async function fetchDescription(job) {
  const description = (await getDescriptionFetcher(job)(job)).trim();
  if (!description) throw new Error("the posting has no description");
  return description.slice(0, MAX_DESCRIPTION_CHARS);
}
