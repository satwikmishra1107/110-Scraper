// const url = "https://walmart.wd504.myworkdayjobs.com/wday/cxs/walmart/WalmartExternal/jobs";
// const url = "https://salesforce.wd12.myworkdayjobs.com/wday/cxs/salesforce/External_Career_Site/jobs";
// const url = "https://adobe.wd5.myworkdayjobs.com/wday/cxs/adobe/external_experienced/jobs";
// const url = "https://adobe.wd5.myworkdayjobs.com/wday/cxs/adobe/external_experienced/jobs";
// const url = "https://sec.wd3.myworkdayjobs.com/wday/cxs/sec/Samsung_Careers/jobs";
// const url = "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs";
// const url = "https://intel.wd1.myworkdayjobs.com/wday/cxs/intel/External/jobs";
// const url = "https://nike.wd1.myworkdayjobs.com/wday/cxs/nike/nke/jobs";
// const url = "https://qualcomm.wd12.myworkdayjobs.com/wday/cxs/qualcomm/External/jobs";
// const url = "https://mastercard.wd1.myworkdayjobs.com/wday/cxs/mastercard/CorporateCareers/jobs";
// const url = "https://visa.wd5.myworkdayjobs.com/wday/cxs/visa/Visa/jobs";
// const url = "https://ms.wd5.myworkdayjobs.com/wday/cxs/ms/External/jobs";   //Morgan Stanley
// const url = "https://zillow.wd5.myworkdayjobs.com/wday/cxs/zillow/Zillow_Group_External/jobs";
// const url = "https://browserstack.wd3.myworkdayjobs.com/wday/cxs/browserstack/External/jobs";
// const url = "https://ffive.wd5.myworkdayjobs.com/wday/cxs/ffive/f5jobs/jobs";
// const url = "https://blackrock.wd1.myworkdayjobs.com/wday/cxs/blackrock/BlackRock_Professional/jobs";
// const url = "https://expedia.wd108.myworkdayjobs.com/wday/cxs/expedia/search/jobs";

const payload = {
  appliedFacets: {},
  limit: 20,
  offset: 0,
  searchText: ""
};

async function getJobs() {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    console.log("Status:", response.status);

    const data = await response.json();

    console.log(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error:", error.message);
  }
}

getJobs();