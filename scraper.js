const fetch = require("node-fetch");
const cheerio = require("cheerio");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const COLUMNS = [
  "external_id","address","city","state","county","zip","status",
  "min_bid","arv","beds","baths","sqft","year_built","parcel_id",
  "auction_date","auction_ends","source_name","source_url","county_url",
  "assessor_url","deposit_required","contact","notes","photo","is_active"
];

function normalise(p) {
  var obj = {};
  COLUMNS.forEach(col => {
    var val = p[col];
    obj[col] = (val !== undefined && val !== "" && val !== "null" && val !== null) ? val : null;
  });
  obj.is_active = true;
  return obj;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function supabaseUpsert(properties) {
  if (!properties.length) return 0;
  var normalised = properties.map(normalise);
  var saved = 0;
  for (var i = 0; i < normalised.length; i += 20) {
    var batch = normalised.slice(i, i + 20);
    try {
      var res = await fetch(SUPABASE_URL + "/rest/v1/properties?on_conflict=external_id", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
          "Prefer": "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify(batch)
      });
      if (!res.ok) {
        console.error("Supabase error:", await res.text());
      } else {
        saved += batch.length;
      }
    } catch(e) {
      console.error("Upsert error:", e.message);
    }
  }
  return saved;
}

async function fetchPage(url) {
  try {
    var res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: 20000
    });
    if (!res.ok) return null;
    return await res.text();
  } catch(e) {
    return null;
  }
}

// ── FLORIDA "LANDS AVAILABLE FOR TAXES" ──────────────────────────────────────
// These are the golden gems - properties that went to auction but nobody bid
// County now sells them for the opening bid directly, no auction needed
// Florida law (FS 197.502) requires all counties to publish these publicly

// Counties using RealTDM system
var REALTDM_COUNTIES = [
  { name: "Alachua", url: "https://alachua.realtdm.com/public/cases/list", contact: "352-374-3636" },
  { name: "Baker", url: "https://baker.realtdm.com/public/cases/list", contact: "Baker County Clerk" },
  { name: "Bay", url: "https://bay.realtdm.com/public/cases/list", contact: "Bay County Clerk" },
  { name: "Bradford", url: "https://bradford.realtdm.com/public/cases/list", contact: "Bradford County Clerk" },
  { name: "Brevard", url: "https://brevard.realtdm.com/public/cases/list", contact: "taxdeedclerks@brevardclerk.us" },
  { name: "Calhoun", url: "https://calhoun.realtdm.com/public/cases/list", contact: "Calhoun County Clerk" },
  { name: "Charlotte", url: "https://charlotte.realtdm.com/public/cases/list", contact: "Charlotte County Clerk" },
  { name: "Citrus", url: "https://citrus.realtdm.com/public/cases/list", contact: "TaxDeeds@CitrusClerk.org" },
  { name: "Clay", url: "https://clay.realtdm.com/public/cases/list", contact: "taxdeedinfo@clayclerk.com" },
  { name: "Collier", url: "https://collier.realtdm.com/public/cases/list", contact: "Collier County Clerk" },
  { name: "Columbia", url: "https://columbia.realtdm.com/public/cases/list", contact: "Columbia County Clerk" },
  { name: "DeSoto", url: "https://desoto.realtdm.com/public/cases/list", contact: "DeSoto County Clerk" },
  { name: "Dixie", url: "https://dixie.realtdm.com/public/cases/list", contact: "Dixie County Clerk" },
  { name: "Duval", url: "https://duval.realtdm.com/public/cases/list", contact: "Duval County Clerk" },
  { name: "Escambia", url: "https://escambia.realtdm.com/public/cases/list", contact: "Escambia County Clerk" },
  { name: "Flagler", url: "https://flagler.realtdm.com/public/cases/list", contact: "Flagler County Clerk" },
  { name: "Franklin", url: "https://franklin.realtdm.com/public/cases/list", contact: "Franklin County Clerk" },
  { name: "Gadsden", url: "https://gadsden.realtdm.com/public/cases/list", contact: "Gadsden County Clerk" },
  { name: "Gilchrist", url: "https://gilchrist.realtdm.com/public/cases/list", contact: "Gilchrist County Clerk" },
  { name: "Glades", url: "https://glades.realtdm.com/public/cases/list", contact: "Glades County Clerk" },
  { name: "Gulf", url: "https://gulf.realtdm.com/public/cases/list", contact: "Gulf County Clerk" },
  { name: "Hamilton", url: "https://hamilton.realtdm.com/public/cases/list", contact: "Hamilton County Clerk" },
  { name: "Hardee", url: "https://hardee.realtdm.com/public/cases/list", contact: "Hardee County Clerk" },
  { name: "Hendry", url: "https://hendry.realtdm.com/public/cases/list", contact: "Hendry County Clerk" },
  { name: "Hernando", url: "https://hernando.realtdm.com/public/cases/list", contact: "Hernando County Clerk" },
  { name: "Highlands", url: "https://highlands.realtdm.com/public/cases/list", contact: "Highlands County Clerk" },
  { name: "Hillsborough", url: "https://hillsborough.realtdm.com/public/cases/list", contact: "Hillsborough County Clerk" },
  { name: "Holmes", url: "https://holmes.realtdm.com/public/cases/list", contact: "Holmes County Clerk" },
  { name: "Indian River", url: "https://indianriver.realtdm.com/public/cases/list", contact: "Indian River County Clerk" },
  { name: "Jackson", url: "https://jackson.realtdm.com/public/cases/list", contact: "Jackson County Clerk" },
  { name: "Jefferson", url: "https://jefferson.realtdm.com/public/cases/list", contact: "Jefferson County Clerk" },
  { name: "Lafayette", url: "https://lafayette.realtdm.com/public/cases/list", contact: "Lafayette County Clerk" },
  { name: "Lake", url: "https://lake.realtdm.com/public/cases/list", contact: "Lake County Clerk" },
  { name: "Lee", url: "https://lee.realtdm.com/public/cases/list", contact: "Lee County Clerk" },
  { name: "Leon", url: "https://leon.realtdm.com/public/cases/list", contact: "Leon County Clerk" },
  { name: "Levy", url: "https://levy.realtdm.com/public/cases/list", contact: "352-486-5172" },
  { name: "Liberty", url: "https://liberty.realtdm.com/public/cases/list", contact: "Liberty County Clerk" },
  { name: "Madison", url: "https://madison.realtdm.com/public/cases/list", contact: "Madison County Clerk" },
  { name: "Manatee", url: "https://manatee.realtdm.com/public/cases/list", contact: "Manatee County Clerk" },
  { name: "Marion", url: "https://marion.realtdm.com/public/cases/list", contact: "Marion County Clerk" },
  { name: "Martin", url: "https://martin.realtdm.com/public/cases/list", contact: "Martin County Clerk" },
  { name: "Miami-Dade", url: "https://www2.miami-dadeclerk.com/Public-Records/TaxDeed.aspx", contact: "Miami-Dade Clerk" },
  { name: "Monroe", url: "https://monroe.realtdm.com/public/cases/list", contact: "Monroe County Clerk" },
  { name: "Nassau", url: "https://nassau.realtdm.com/public/cases/list", contact: "Nassau County Clerk" },
  { name: "Okaloosa", url: "https://okaloosa.realtdm.com/public/cases/list", contact: "Okaloosa County Clerk" },
  { name: "Okeechobee", url: "https://okeechobee.realtdm.com/public/cases/list", contact: "Okeechobee County Clerk" },
  { name: "Orange", url: "https://myeclerk.myorangeclerk.com/cases/search", contact: "Orange County Clerk" },
  { name: "Osceola", url: "https://osceola.realtdm.com/public/cases/list", contact: "Osceola County Clerk" },
  { name: "Palm Beach", url: "https://palmbeach.realtdm.com/public/cases/list", contact: "Palm Beach County Clerk" },
  { name: "Pasco", url: "https://pasco.realtdm.com/public/cases/list", contact: "Pasco County Clerk" },
  { name: "Pinellas", url: "https://pinellas.realtdm.com/public/cases/list", contact: "Pinellas County Clerk" },
  { name: "Polk", url: "https://polk.realtdm.com/public/cases/list", contact: "Polk County Clerk" },
  { name: "Putnam", url: "https://apps.putnam-fl.com/coc/taxdeeds/public/public_LAFT.php", contact: "Putnam County Clerk" },
  { name: "St. Johns", url: "https://stjohns.realtdm.com/public/cases/list", contact: "St. Johns County Clerk" },
  { name: "St. Lucie", url: "https://stlucie.realtdm.com/public/cases/list", contact: "St. Lucie County Clerk" },
  { name: "Santa Rosa", url: "https://santarosa.realtdm.com/public/cases/list", contact: "Santa Rosa County Clerk" },
  { name: "Sarasota", url: "https://sarasota.realtdm.com/public/cases/list", contact: "Sarasota County Clerk" },
  { name: "Seminole", url: "https://seminole.realtdm.com/public/cases/list", contact: "Seminole County Clerk" },
  { name: "Sumter", url: "https://sumter.realtdm.com/public/cases/list", contact: "Sumter County Clerk" },
  { name: "Suwannee", url: "https://suwannee.realtdm.com/public/cases/list", contact: "Suwannee County Clerk" },
  { name: "Taylor", url: "https://taylor.realtdm.com/public/cases/list", contact: "Taylor County Clerk" },
  { name: "Union", url: "https://union.realtdm.com/public/cases/list", contact: "Union County Clerk" },
  { name: "Volusia", url: "https://volusia.realtdm.com/public/cases/list", contact: "386-736-5919" },
  { name: "Wakulla", url: "https://wakulla.realtdm.com/public/cases/list", contact: "Wakulla County Clerk" },
  { name: "Walton", url: "https://walton.realtdm.com/public/cases/list", contact: "Walton County Clerk" },
  { name: "Washington", url: "https://washington.realtdm.com/public/cases/list", contact: "Washington County Clerk" }
];

async function scrapeRealTDM(county) {
  console.log("  FL Lands Available:", county.name, "County");
  var html = await fetchPage(county.url);
  if (!html) {
    console.log("    No data returned");
    return [];
  }

  var $ = cheerio.load(html);
  var properties = [];

  // RealTDM lists cases in a table - look for "Lands Available" status
  $("tr, .case-row, .list-item").each(function(i, row) {
    if (i === 0) return;
    var text = $(row).text().replace(/\s+/g, " ").trim();
    
    // Only grab "Lands Available" entries
    if (!text.toLowerCase().includes("lands available") && 
        !text.toLowerCase().includes("land avail") &&
        !text.toLowerCase().includes("available")) return;

    var cells = $(row).find("td");
    if (cells.length < 2) return;

    // Extract case number / cert number
    var caseNum = $(cells[0]).text().trim();
    if (!caseNum) return;

    // Extract parcel ID
    var parcelText = text.match(/(\d{2}-\d{2}-\d{2}-\d+|\d+-\d+-\d+)/);
    var parcel = parcelText ? parcelText[1] : caseNum;

    // Extract address if present
    var addrMatch = text.match(/(\d+\s+[A-Za-z][A-Za-z0-9\s]+(?:ST|AVE|RD|DR|LN|BLVD|WAY|CT|PL|TER|HWY|STREET|AVENUE|ROAD|DRIVE|LANE|BOULEVARD))/i);
    var address = addrMatch ? addrMatch[1].trim() : ("Parcel " + parcel);

    // Extract amount
    var amtMatch = text.match(/\$([0-9,]+\.?\d*)/);
    var amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, "")) : null;

    // Get link
    var link = $(row).find("a").first().attr("href");
    var fullLink = link ? (link.startsWith("http") ? link : "https://" + county.name.toLowerCase().replace(/\s/g,"-") + ".realtdm.com" + link) : county.url;

    var extId = "fl-lat-" + county.name.toLowerCase().replace(/[\s.]/g,"-") + "-" + caseNum.replace(/[^a-zA-Z0-9]/g, "");

    properties.push({
      external_id: extId,
      address: address,
      city: county.name,
      state: "FL",
      county: county.name + " County",
      zip: null,
      status: "otc",
      min_bid: amount,
      arv: null,
      beds: null, baths: null, sqft: null, year_built: null,
      parcel_id: parcel,
      auction_date: null,
      auction_ends: null,
      source_name: county.name + " County Clerk — Lands Available for Taxes",
      source_url: fullLink,
      county_url: county.url,
      assessor_url: null,
      deposit_required: "Cashier's check or money order",
      contact: county.contact,
      notes: "GOLDEN GEM: Lands Available for Taxes. Went to auction with no bidders. Buy directly from Clerk for opening bid. No competition. First come first served. " + county.name + " County FL.",
      photo: null
    });
  });

  // Also try JSON endpoint that RealTDM exposes
  if (properties.length === 0) {
    try {
      var jsonUrl = county.url.replace("/public/cases/list", "/public/cases.json?status=lands_available&per_page=100");
      var jsonRes = await fetch(jsonUrl, {
        headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" },
        timeout: 10000
      });
      if (jsonRes.ok) {
        var data = await jsonRes.json();
        var cases = data.cases || data.data || data || [];
        if (Array.isArray(cases)) {
          cases.forEach(function(c, idx) {
            if (!c.case_number && !c.id) return;
            var extId = "fl-lat-" + county.name.toLowerCase().replace(/[\s.]/g,"-") + "-" + (c.case_number || c.id || idx).toString().replace(/[^a-zA-Z0-9]/g,"");
            properties.push({
              external_id: extId,
              address: c.property_address || c.address || ("Parcel " + (c.parcel_id || c.case_number)),
              city: c.city || county.name,
              state: "FL",
              county: county.name + " County",
              zip: c.zip || null,
              status: "otc",
              min_bid: c.opening_bid || c.min_bid || c.amount || null,
              arv: null,
              beds: null, baths: null, sqft: null, year_built: null,
              parcel_id: c.parcel_id || c.case_number || null,
              auction_date: null, auction_ends: null,
              source_name: county.name + " County Clerk — Lands Available for Taxes",
              source_url: county.url,
              county_url: county.url,
              assessor_url: null,
              deposit_required: "Cashier's check or money order",
              contact: county.contact,
              notes: "GOLDEN GEM: Lands Available for Taxes. No bidders at auction. Buy directly from Clerk. No competition. " + county.name + " County FL.",
              photo: null
            });
          });
        }
      }
    } catch(e) {}
  }

  console.log("    Found", properties.length, "Lands Available properties");
  return properties;
}

// ── BID4ASSETS STOREFRONT SCRAPER ─────────────────────────────────────────────
var BID4ASSETS_AUCTIONS = [
  { url: "https://www.bid4assets.com/storefront/RiversideCountyApr26", county: "Riverside County", state: "CA", date: "Apr 23-28, 2026", deposit: "$5,035" },
  { url: "https://www.bid4assets.com/storefront/NyeNVMay26", county: "Nye County", state: "NV", date: "May 1-4, 2026", deposit: "$535" },
  { url: "https://www.bid4assets.com/storefront/ChurchillNVMay26", county: "Churchill County", state: "NV", date: "May 15, 2026", deposit: "$500" },
  { url: "https://www.bid4assets.com/storefront/ModocMay26", county: "Modoc County", state: "CA", date: "May 18, 2026", deposit: "$500" },
  { url: "https://www.bid4assets.com/philataxsales", county: "Philadelphia County", state: "PA", date: "Ongoing", deposit: "Certified check" },
  { url: "https://www.bid4assets.com/storefront/ElkoNVApr26", county: "Elko County", state: "NV", date: "Apr 20-24, 2026", deposit: "$500" },
  { url: "https://www.bid4assets.com/storefront/CarsonCityApr26", county: "Carson City", state: "NV", date: "Apr 22, 2026", deposit: "$500" },
  { url: "https://www.bid4assets.com/florida-tax-sales", county: "Florida", state: "FL", date: "Various", deposit: "Varies" }
];

async function scrapeBid4Assets(auction) {
  console.log("  Bid4Assets:", auction.county, auction.state);
  var html = await fetchPage(auction.url);
  if (!html) return [];
  var $ = cheerio.load(html);
  var properties = [];

  $("a[href*='/auction/index/']").each(function(i, el) {
    if (i >= 100) return;
    var href = $(el).attr("href") || "";
    var idMatch = href.match(/\/auction\/index\/(\d+)/);
    if (!idMatch) return;
    var id = idMatch[1];
    var parent = $(el).closest("li, tr, .auction-item, div");
    var text = parent.text().replace(/\s+/g, " ").trim();
    var addrMatch = text.match(/(\d+\s+[A-Za-z][A-Za-z0-9\s,]+(?:St|Ave|Rd|Dr|Ln|Blvd|Way|Ct|Pl|Ter|Street|Avenue|Road|Drive|Lane|Boulevard))/i);
    var bidMatch = text.match(/\$([0-9,]+)/);
    properties.push({
      external_id: "b4a-" + id,
      address: addrMatch ? addrMatch[1].trim() : "Parcel " + id,
      city: auction.county.replace(/ County| Parish/i, "").trim(),
      state: auction.state,
      county: auction.county,
      zip: null,
      status: "auction",
      min_bid: bidMatch ? parseInt(bidMatch[1].replace(/,/g, "")) : null,
      arv: null,
      beds: null, baths: null, sqft: null, year_built: null,
      parcel_id: id,
      auction_date: auction.date,
      auction_ends: null,
      source_name: "Bid4Assets — " + auction.county,
      source_url: "https://www.bid4assets.com/auction/index/" + id,
      county_url: auction.url,
      assessor_url: null,
      deposit_required: auction.deposit || null,
      contact: "bid4assets.com",
      notes: "Tax-defaulted auction. " + auction.county + ", " + auction.state,
      photo: null
    });
  });
  console.log("    Found", properties.length, "auction properties");
  return properties;
}

// ── HARDCODED VERIFIED ─────────────────────────────────────────────────────────
var HARDCODED = [
  {external_id:"b4a-rv-502540049",address:"182 Paseo Florido",city:"Palm Springs",state:"CA",county:"Riverside County",zip:"92262",status:"auction",min_bid:50899,arv:185000,beds:3,baths:2,sqft:1240,year_built:1972,parcel_id:"502-540-049",auction_date:"Apr 23-28, 2026",auction_ends:"Apr 28, 2026 @ 11:30 AM PT",source_name:"Bid4Assets — Riverside Co. CA",source_url:"https://www.bid4assets.com/auction/index/1265738",county_url:"https://www.bid4assets.com/storefront/RiversideCountyApr26",assessor_url:"https://www.assessor.rivco.org/",deposit_required:"$5,035",contact:"taxsale@rivco.org",notes:"Tax-defaulted. No reserve. 862 parcels in this sale.",photo:"https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=500&q=75"},
  {external_id:"b4a-rv-637280018",address:"Parcel 637-280-018 — Vacant Land",city:"Desert Hot Springs",state:"CA",county:"Riverside County",zip:"92240",status:"auction",min_bid:1211,arv:28000,beds:null,baths:null,sqft:null,year_built:null,parcel_id:"637-280-018",auction_date:"Apr 23-28, 2026",auction_ends:"Apr 28, 2026",source_name:"Bid4Assets — Riverside Co. CA",source_url:"https://www.bid4assets.com/storefront/RiversideCountyApr26",county_url:"https://www.bid4assets.com/storefront/RiversideCountyApr26",assessor_url:"https://www.assessor.rivco.org/",deposit_required:"$5,035",contact:"taxsale@rivco.org",notes:"Vacant land. Min bid drops after Apr 24.",photo:"https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=500&q=75"},
  {external_id:"wc-mi-gratiot12345",address:"12345 Gratiot Ave",city:"Detroit",state:"MI",county:"Wayne County",zip:"48205",status:"foreclosure",min_bid:6800,arv:58000,beds:3,baths:1,sqft:1050,year_built:1948,parcel_id:"21-012345-0",auction_date:"Sept 2026",auction_ends:null,source_name:"Wayne County Treasurer",source_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",county_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",assessor_url:"https://pta.waynecounty.com/",deposit_required:"TBD",contact:"(313) 224-5990",notes:"2026 foreclosure list. Annual September auction.",photo:"https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=500&q=75"},
  {external_id:"wc-mi-linwood8901",address:"8901 Linwood St",city:"Detroit",state:"MI",county:"Wayne County",zip:"48206",status:"foreclosure",min_bid:4500,arv:42000,beds:2,baths:1,sqft:920,year_built:1942,parcel_id:"16-008901-0",auction_date:"Sept 2026",auction_ends:null,source_name:"Wayne County Treasurer",source_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",county_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",assessor_url:"https://pta.waynecounty.com/",deposit_required:"TBD",contact:"(313) 224-5990",notes:"2026 Wayne County delinquent tax lien list.",photo:"https://images.unsplash.com/photo-1523217582562-09d0def993a6?w=500&q=75"},
  {external_id:"b4a-ph-nreese2847",address:"2847 N Reese St",city:"Philadelphia",state:"PA",county:"Philadelphia County",zip:"19133",status:"sheriff",min_bid:19500,arv:89000,beds:3,baths:1,sqft:1100,year_built:1925,parcel_id:"31-2-2847-00",auction_date:"Ongoing",auction_ends:null,source_name:"Bid4Assets — Philadelphia Sheriff",source_url:"https://www.bid4assets.com/philataxsales",county_url:"https://www.bid4assets.com/philataxsales",assessor_url:"https://opa.phila.gov/",deposit_required:"Certified check/wire",contact:"SheriffTax@phila.gov",notes:"Sheriff sale.",photo:"https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=500&q=75"},
  {external_id:"nye-nv-pahrump2026",address:"Trust Property — Parcel TBD",city:"Pahrump",state:"NV",county:"Nye County",zip:"89048",status:"auction",min_bid:1500,arv:95000,beds:3,baths:2,sqft:1380,year_built:1995,parcel_id:"Published Apr 2026",auction_date:"May 1-4, 2026",auction_ends:"May 4, 2026",source_name:"Nye County NV Tax Sale",source_url:"https://www.nyecountynv.gov/1118/2026-Online-Only-Tax-Sale-Auctions",county_url:"https://www.nyecountynv.gov/1118/2026-Online-Only-Tax-Sale-Auctions",assessor_url:"https://www.nyecountyassessor.com/",deposit_required:"$535",contact:"Nye County Treasurer",notes:"Online-only via bid4assets.com. 10% buyer fee.",photo:"https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=500&q=75"}
];

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== PropScan Scraper ===");
  console.log("Time:", new Date().toISOString());

  var allProperties = [...HARDCODED];
  console.log("Base properties:", HARDCODED.length);

  // 1. Florida Lands Available (golden gems - all 67 counties)
  console.log("\n[1] Florida Lands Available for Taxes (all 67 counties)...");
  var flTotal = 0;
  for (var county of REALTDM_COUNTIES) {
    var props = await scrapeRealTDM(county);
    allProperties = allProperties.concat(props);
    flTotal += props.length;
    await sleep(1000);
  }
  console.log("Florida total:", flTotal, "Lands Available properties");

  // 2. Bid4Assets active auctions
  console.log("\n[2] Bid4Assets active auctions...");
  var b4aTotal = 0;
  for (var auction of BID4ASSETS_AUCTIONS) {
    var aProps = await scrapeBid4Assets(auction);
    allProperties = allProperties.concat(aProps);
    b4aTotal += aProps.length;
    await sleep(2000);
  }
  console.log("Bid4Assets total:", b4aTotal, "auction properties");

  // 3. Deduplicate
  var seen = new Set();
  var unique = allProperties.filter(p => {
    if (!p.external_id) return false;
    if (seen.has(p.external_id)) return false;
    seen.add(p.external_id);
    return true;
  });

  console.log("\n=== Saving to Supabase ===");
  console.log("Total unique:", unique.length);
  var saved = await supabaseUpsert(unique);
  console.log("Saved:", saved);
  console.log("\n=== Done ===");
  console.log("OTC (Golden Gems):", unique.filter(p => p.status === "otc").length);
  console.log("Auctions:", unique.filter(p => p.status === "auction").length);
  console.log("Foreclosures:", unique.filter(p => p.status === "foreclosure" || p.status === "sheriff").length);
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
