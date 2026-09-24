// test-greenhouse.mjs | run: node test-greenhouse.mjs

// The ID from your Stripe JSON sample
const JOB_ID = 7844214; 
const BOARD_TOKEN = "stripe"; // Greenhouse's internal name for Stripe's job board

async function testGreenhouseAPI() {
  const url = `https://boards-api.greenhouse.io/v1/boards/${BOARD_TOKEN}/jobs/${JOB_ID}`;
  
  console.log(`Pinging Greenhouse API...\nURL: ${url}\n`);

  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    
    // 1. Print the specific fields we care about for filtering
    console.log("✅ SUCCESS! Extracted Core Data:");
    console.log("-----------------------------------");
    console.log(`Job Title  : ${data.title}`);
    console.log(`Created At : ${data.created_at}`);
    console.log(`Updated At : ${data.updated_at}`);
    console.log(`Location   : ${data.location?.name}`);
    console.log("-----------------------------------\n");

    // 2. Print the entire JSON so you can inspect if there's other useful "crap" or data
    console.log("Full Raw JSON Response from Greenhouse:");
    console.log(JSON.stringify(data, null, 2));

  } catch (error) {
    console.error("❌ API Ping Failed:", error.message);
  }
}

testGreenhouseAPI();