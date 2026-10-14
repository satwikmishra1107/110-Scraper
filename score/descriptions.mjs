// score/descriptions.mjs — a job's full description, read from its platform's public API.
// Only the five ATS platforms for now; custom-site jobs have no description (and so no score) yet.
import { fetchJson, loadCompanies } from "../ats-common.mjs";

const MAX_DESCRIPTION_CHARS = 20_000; // a few very long postings repeat the same boilerplate; this is plenty

// Each scraper's company list: maps the stored company name back to its API address / slug
const COMPANY_LISTS = {
  workday: loadCompanies("./workday/workday.json"), // { name, url }
  greenhouse: loadCompanies("./greenhouse/greenhouse.json"), // { company, slug }
  lever: loadCompanies("./lever/lever.json"),
  ashby: loadCompanies("./ashby/ashby.json"),
  smartrecruiters: loadCompanies("./smartrecruiters/smartrecruiters.json"),
};

function findCompany(source, companyName) {
  const nameField = source === "workday" ? "name" : "company";
  const company = COMPANY_LISTS[source].find((listedCompany) => listedCompany[nameField] === companyName);
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
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Ashby has no one-job endpoint, so each company's board is fetched once per run and reused
const ashbyBoards = new Map();

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
    if (!ashbyBoards.has(slug)) {
      ashbyBoards.set(slug, fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`));
    }
    const board = await ashbyBoards.get(slug);
    const posting = (board.jobs ?? []).find((boardJob) => boardJob.id === job.job_id);
    if (!posting) throw new Error("no longer on the company's board");
    return posting.descriptionPlain || htmlToText(posting.descriptionHtml);
  },

  // Sections: companyDescription (skipped, it's the same for every job), jobDescription, qualifications, additionalInformation
  async smartrecruiters(job) {
    const { slug } = findCompany("smartrecruiters", job.company);
    const data = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings/${job.job_id}`);
    const sections = data.jobAd?.sections ?? {};
    return ["jobDescription", "qualifications", "additionalInformation"]
      .map((sectionName) => sections[sectionName])
      .filter((section) => section?.text)
      .map((section) => `${section.title ?? ""}\n${htmlToText(section.text)}`.trim())
      .join("\n\n");
  },
};

export const SOURCES_WITH_DESCRIPTIONS = Object.keys(DESCRIPTION_FETCHERS);

/** The job's description as plain text. Throws if the platform has none or the request fails. */
export async function fetchDescription(job) {
  const description = (await DESCRIPTION_FETCHERS[job.source](job)).trim();
  if (!description) throw new Error("the posting has no description");
  return description.slice(0, MAX_DESCRIPTION_CHARS);
}
