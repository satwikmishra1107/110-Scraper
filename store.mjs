import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } },
);

const BATCH_SIZE = 500;

// ---------- Workday facet cache (table: workday_facets) ----------

export async function loadFacetCache() {
  const { data, error } = await supabase.from("workday_facets").select("company, facets");
  if (error) throw new Error(`Supabase facet load failed: ${error.message}`);
  return Object.fromEntries(data.map((row) => [row.company, row.facets]));
}

export async function saveFacet(company, facets) {
  const { error } = await supabase
    .from("workday_facets")
    .upsert({ company, facets, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Supabase facet save failed: ${error.message}`);
}

export async function deleteFacet(company) {
  const { error } = await supabase.from("workday_facets").delete().eq("company", company);
  if (error) throw new Error(`Supabase facet delete failed: ${error.message}`);
}

// ---------- Jobs (table: jobs) ----------

export async function saveJobsAndGetNew(jobs) {
  const unique = [...new Map(jobs.map((j) => [`${j.company}|${j.job_id}`, j])).values()];
  const rows = unique.map(({ scraped_at, ...row }) => row); // scraped_at isn't a column

  const newJobs = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const { data, error } = await supabase
      .from("jobs")
      .upsert(rows.slice(i, i + BATCH_SIZE), {
        onConflict: "company,job_id",
        ignoreDuplicates: true, // ON CONFLICT DO NOTHING
      })
      .select();
    if (error) throw new Error(`Supabase insert failed: ${error.message}`);
    newJobs.push(...data);
  }
  return newJobs;
}