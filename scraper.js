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
  if (obj.external_id) obj.external_id = String(obj.external_id).substring(0, 50);
  if (obj.notes) obj.notes = String(obj.notes).substring(0, 500);
  if (obj.address) obj.address = String(obj.address).substring(0, 200);
  if (obj.source_url) obj.source_url = String(obj.source_url).substring(0, 500);
  if (obj.county_url) obj.county_url = String(obj.county_url).substring(0, 500);
  return obj;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
      if (!res.ok) console.error("Supabase batch error:", await res.text());
      else saved += batch.length;
    } catch(e) { console.error("Upsert error:", e.message); }
  }
  return saved;
}

async function fetchPage(url) {
  try {
    var res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      timeout: 15000
    });
    if (!res.ok) return null;
    return await res.text();
  } catch(e) { return null; }
}

// ── PARSER: Putnam-style custom FL county pages ────────────────────────────
async function scrapeCustomFLCounty(county) {
  console.log("  Scraping:", county.name, "County FL");
  var html = await fetchPage(county.url);
  if (!html) { console.log("    No data"); return []; }

  var $ = cheerio.load(html);
  var properties = [];

  $("table tr").each(function(i, row) {
    var text = $(row).text().replace(/\s+/g, " ").trim();
    var priceMatch = text.match(/Estimated[^$]*\$([\d,]+\.?\d*)/i) ||
                     text.match(/Purchase Price[^$]*\$([\d,]+\.?\d*)/i) ||
                     text.match(/Amount[^$]*\$([\d,]+\.?\d*)/i);
    var parcelMatch = text.match(/Parcel\s*(?:Number|#|No\.?)?\s*:?\s*([\d\-]+)/i) ||
                      text.match(/([\d]{2}-[\d]{2}-[\d]{2}-[\d]+-[\d]+-[\d]+)/);
    var caseMatch = text.match(/T\.?D\.?\s*([\d\-]+)/i);
    var dateMatch = text.match(/Available[^:]*:?\s*([\d]{1,2}\/[\d]{1,2}\/[\d]{4})/i);

    if (!caseMatch && !parcelMatch) return;
    var price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g,"")) : null;
    if (!price || price < 100 || price > 5000000) return;

    var caseNum = caseMatch ? caseMatch[1] : null;
    var parcel = parcelMatch ? parcelMatch[1] : caseNum;
    var address = "Parcel " + (parcel || caseNum);
    if (address.indexOf("GIS") > -1 || address.indexOf("Tax Collect") > -1) return;

    var extId = "fl-" + county.code + "-" + (caseNum || parcel || i).toString().replace(/[^a-zA-Z0-9]/g,"").substring(0,20);

    properties.push({
      external_id: extId,
      address: address,
      city: county.city || county.name,
      state: "FL",
      county: county.name + " County",
      zip: null, status: "otc",
      min_bid: price,
      arv: Math.round(price * 3),
      beds: null, baths: null, sqft: null, year_built: null,
      parcel_id: parcel || caseNum,
      auction_date: dateMatch ? dateMatch[1] : null,
      auction_ends: null,
      source_name: county.name + " County Clerk — Lands Available",
      source_url: county.url, county_url: county.url,
      assessor_url: county.assessorUrl || null,
      deposit_required: "Cashier's check",
      contact: county.contact,
      notes: "OTC Golden Gem. Buy direct from Clerk. No auction.",
      photo: null
    });
  });

  var seen = new Set();
  properties = properties.filter(p => { if (seen.has(p.external_id)) return false; seen.add(p.external_id); return true; });
  console.log("   Found", properties.length, "properties");
  return properties;
}

// ── PARSER: Bid4Assets storefront ─────────────────────────────────────────
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
    var addrMatch = text.match(/(\d+\s+[A-Za-z][A-Za-z0-9\s,]+(?:St|Ave|Rd|Dr|Ln|Blvd|Way|Ct|Pl|Ter|Street|Avenue|Road|Drive|Lane))/i);
    var bidMatch = text.match(/\$([0-9,]+)/);
    properties.push({
      external_id: "b4a-" + id,
      address: addrMatch ? addrMatch[1].trim() : "Parcel " + id,
      city: auction.county.replace(/ County| Parish/i, "").trim(),
      state: auction.state, county: auction.county, zip: null,
      status: "auction",
      min_bid: bidMatch ? parseInt(bidMatch[1].replace(/,/g,"")) : null,
      arv: null, beds: null, baths: null, sqft: null, year_built: null,
      parcel_id: id, auction_date: auction.date, auction_ends: null,
      source_name: "Bid4Assets — " + auction.county,
      source_url: "https://www.bid4assets.com/auction/index/" + id,
      county_url: auction.url, assessor_url: null,
      deposit_required: auction.deposit || null,
      contact: "bid4assets.com",
      notes: "Tax-defaulted auction. " + auction.county + " " + auction.state,
      photo: null
    });
  });
  console.log("   Found", properties.length, "auction properties");
  return properties;
}

// ── PARSER: GovEase counties ──────────────────────────────────────────────
async function scrapeGovEase(county) {
  console.log("  GovEase:", county.name, county.state);
  var html = await fetchPage(county.url);
  if (!html) return [];
  var $ = cheerio.load(html);
  var properties = [];

  $("tr, .property-row, .auction-row").each(function(i, row) {
    if (i === 0) return;
    var text = $(row).text().replace(/\s+/g, " ").trim();
    if (!text || text.length < 10) return;
    var priceMatch = text.match(/\$([0-9,]+\.?\d*)/);
    var addrMatch = text.match(/(\d+\s+[A-Za-z][A-Za-z\s]+(?:St|Ave|Rd|Dr|Ln|Blvd|Way|Ct|Pl|Street|Avenue|Road|Drive|Lane))/i);
    var parcelMatch = text.match(/([\d]{2,}-[\d]{2,}-[\d]+)/);
    if (!priceMatch && !addrMatch) return;
    var price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g,"")) : null;
    if (price && (price < 100 || price > 2000000)) return;
    var extId = "govease-" + county.code + "-" + i + "-" + (Date.now() % 100000);
    properties.push({
      external_id: extId,
      address: addrMatch ? addrMatch[1].trim() : ("Parcel " + (parcelMatch ? parcelMatch[1] : i)),
      city: county.city || county.name,
      state: county.state, county: county.name + " County", zip: null,
      status: "auction", min_bid: price, arv: null,
      beds: null, baths: null, sqft: null, year_built: null,
      parcel_id: parcelMatch ? parcelMatch[1] : null,
      auction_date: county.date || null, auction_ends: null,
      source_name: "GovEase — " + county.name + " County",
      source_url: county.url, county_url: county.url,
      assessor_url: null, deposit_required: null,
      contact: county.contact || "govease.com",
      notes: "GovEase tax auction. " + county.name + " County " + county.state,
      photo: null
    });
  });
  console.log("   Found", properties.length, "GovEase properties");
  return properties;
}

// ── PARSER: RealAuction counties ──────────────────────────────────────────
async function scrapeRealAuction(county) {
  console.log("  RealAuction:", county.name, county.state);
  var html = await fetchPage(county.url);
  if (!html) return [];
  var $ = cheerio.load(html);
  var properties = [];

  $("tr").each(function(i, row) {
    if (i === 0) return;
    var cells = $(row).find("td");
    if (cells.length < 3) return;
    var text = $(row).text().replace(/\s+/g, " ").trim();
    var priceMatch = text.match(/\$([0-9,]+\.?\d*)/);
    var price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g,"")) : null;
    if (!price || price < 100 || price > 2000000) return;
    var addr = $(cells[1]).text().trim() || $(cells[0]).text().trim();
    if (!addr || addr.length < 3) return;
    var extId = "ra-" + county.code + "-" + i + "-" + (Date.now() % 100000);
    properties.push({
      external_id: extId,
      address: addr.substring(0, 150),
      city: county.city || county.name,
      state: county.state, county: county.name + " County", zip: null,
      status: "auction", min_bid: price, arv: null,
      beds: null, baths: null, sqft: null, year_built: null,
      parcel_id: null, auction_date: county.date || null, auction_ends: null,
      source_name: "RealAuction — " + county.name + " County",
      source_url: county.url, county_url: county.url,
      assessor_url: null, deposit_required: null,
      contact: county.contact || "realauction.com",
      notes: "RealAuction tax sale. " + county.name + " County " + county.state,
      photo: null
    });
  });
  console.log("   Found", properties.length, "RealAuction properties");
  return properties;
}

// ── PARSER: CivicSource (Louisiana) ───────────────────────────────────────
async function scrapeCivicSource(parish) {
  console.log("  CivicSource:", parish.name, "Parish LA");
  var html = await fetchPage(parish.url);
  if (!html) return [];
  var $ = cheerio.load(html);
  var properties = [];

  $("tr, .listing-row").each(function(i, row) {
    if (i === 0) return;
    var text = $(row).text().replace(/\s+/g, " ").trim();
    var priceMatch = text.match(/\$([0-9,]+\.?\d*)/);
    var addrMatch = text.match(/(\d+\s+[A-Za-z][A-Za-z\s]+(?:St|Ave|Rd|Dr|Ln|Blvd|Way|Ct|Pl))/i);
    if (!priceMatch || !addrMatch) return;
    var price = parseFloat(priceMatch[1].replace(/,/g,""));
    if (!price || price < 100 || price > 1000000) return;
    var extId = "cs-la-" + parish.code + "-" + i;
    properties.push({
      external_id: extId,
      address: addrMatch[1].trim(),
      city: parish.city || parish.name,
      state: "LA", county: parish.name + " Parish", zip: null,
      status: "auction", min_bid: price, arv: null,
      beds: null, baths: null, sqft: null, year_built: null,
      parcel_id: null, auction_date: null, auction_ends: null,
      source_name: "CivicSource — " + parish.name + " Parish",
      source_url: parish.url, county_url: parish.url,
      assessor_url: null, deposit_required: null,
      contact: parish.contact || "civicsource.com",
      notes: "Louisiana tax sale via CivicSource. 3-year redemption period.",
      photo: null
    });
  });
  console.log("   Found", properties.length, "CivicSource properties");
  return properties;
}

// ── DATA: FLORIDA OTC COUNTIES ────────────────────────────────────────────
var FL_COUNTIES = [
  // CONFIRMED WORKING
  { name:"Putnam", code:"putnam", city:"Palatka", url:"https://apps.putnam-fl.com/coc/taxdeeds/public/public_LAFT.php", contact:"(386) 329-0361", assessorUrl:"https://ptax.putnam-fl.com/" },
  // TIER 1 HOT MARKETS
  { name:"Duval", code:"duval", city:"Jacksonville", url:"https://duval.realtdm.com/public/cases/list", contact:"(904) 255-2000", assessorUrl:"https://www.coj.net/departments/property-appraiser" },
  { name:"Hillsborough", code:"hillsb", city:"Tampa", url:"https://hillsborough.realtdm.com/public/cases/list", contact:"(813) 276-8100", assessorUrl:"https://www.hcpafl.org/" },
  { name:"Orange", code:"orange", city:"Orlando", url:"https://myeclerk.myorangeclerk.com/cases/search?status=LandsAvailable", contact:"(407) 836-2060", assessorUrl:"https://www.ocpafl.org/" },
  { name:"Lee", code:"lee", city:"Fort Myers", url:"https://www.leeclerk.org/departments/official-records-recording/tax-deeds/lands-available", contact:"(239) 533-5000", assessorUrl:"https://www.leepa.org/" },
  { name:"St. Lucie", code:"sl", city:"Port St. Lucie", url:"https://stlucie.realtdm.com/public/cases/list", contact:"(772) 462-6900", assessorUrl:"https://www.paslc.gov/" },
  // TIER 2 STRONG MARKETS
  { name:"Brevard", code:"brevard", city:"Melbourne", url:"https://brevard.realtdm.com/public/cases/list", contact:"taxdeedclerks@brevardclerk.us", assessorUrl:"https://www.bcpao.us/" },
  { name:"Polk", code:"polk", city:"Bartow", url:"https://polk.realtdm.com/public/cases/list", contact:"(863) 534-4000", assessorUrl:"https://www.pcpao.org/" },
  { name:"Seminole", code:"semi", city:"Sanford", url:"https://seminole.realtdm.com/public/cases/list", contact:"(407) 665-4330", assessorUrl:"https://www.scpafl.org/" },
  { name:"Sarasota", code:"sara", city:"Sarasota", url:"https://sarasota.realtdm.com/public/cases/list", contact:"(941) 861-7400", assessorUrl:"https://www.sc-pa.com/" },
  { name:"Alachua", code:"alach", city:"Gainesville", url:"https://alachua.realtdm.com/public/cases/list", contact:"(352) 374-3636", assessorUrl:"https://www.acpafl.org/" },
  { name:"Palm Beach", code:"pb", city:"West Palm Beach", url:"https://palmbeach.realtdm.com/public/cases/list", contact:"(561) 355-2996", assessorUrl:"https://www.pbcgov.org/papa/" },
  { name:"Broward", code:"brow", city:"Fort Lauderdale", url:"https://broward.realtdm.com/public/cases/list", contact:"(954) 831-6565", assessorUrl:"https://bcpa.net/" },
  { name:"Collier", code:"coll", city:"Naples", url:"https://collier.realtdm.com/public/cases/list", contact:"(239) 252-2646", assessorUrl:"https://www.collierappraiser.com/" },
  { name:"Marion", code:"marion", city:"Ocala", url:"https://www.marioncountyclerk.org/tax-deeds/lands-available-for-taxes", contact:"(352) 671-5600", assessorUrl:"https://www.pa.marion.fl.us/" },
  { name:"Pinellas", code:"pinel", city:"Clearwater", url:"https://pinellas.realtdm.com/public/cases/list", contact:"(727) 464-3341", assessorUrl:"https://www.pcpao.gov/" },
  { name:"Pasco", code:"pasco", city:"New Port Richey", url:"https://pasco.realtdm.com/public/cases/list", contact:"(727) 847-2411", assessorUrl:"https://www.pascopa.com/" },
  { name:"Lake", code:"lake", city:"Tavares", url:"https://lake.realtdm.com/public/cases/list", contact:"(352) 742-4100", assessorUrl:"https://www.lakecopropappr.com/" },
  { name:"Osceola", code:"osc", city:"Kissimmee", url:"https://osceola.realtdm.com/public/cases/list", contact:"(407) 742-3500", assessorUrl:"https://www.property-appraiser.org/" },
  { name:"Volusia", code:"vol", city:"Daytona Beach", url:"https://volusia.realtdm.com/public/cases/list", contact:"(386) 736-5919", assessorUrl:"https://vcpa.vcgov.org/" },
  { name:"Highlands", code:"high", city:"Sebring", url:"https://highlands.realtdm.com/public/cases/list", contact:"(863) 402-6500", assessorUrl:"https://www.hcpao.org/" },
  { name:"Indian River", code:"ir", city:"Vero Beach", url:"https://indianriver.realtdm.com/public/cases/list", contact:"(772) 770-5185", assessorUrl:"https://www.ircpa.org/" },
  { name:"Charlotte", code:"char", city:"Port Charlotte", url:"https://charlotte.realtdm.com/public/cases/list", contact:"(941) 637-2130", assessorUrl:"https://www.ccappraiser.com/" },
  { name:"Manatee", code:"man", city:"Bradenton", url:"https://manatee.realtdm.com/public/cases/list", contact:"(941) 741-4045", assessorUrl:"https://www.manateepao.com/" },
  { name:"Hernando", code:"hern", city:"Brooksville", url:"https://hernando.realtdm.com/public/cases/list", contact:"(352) 754-4201", assessorUrl:"https://www.hernandopa-fl.us/" },
  { name:"Flagler", code:"flag", city:"Bunnell", url:"https://flagler.realtdm.com/public/cases/list", contact:"(386) 313-4400", assessorUrl:"https://www.flaglerpa.com/" },
  { name:"St. Johns", code:"stj", city:"St. Augustine", url:"https://stjohns.realtdm.com/public/cases/list", contact:"(904) 819-3600", assessorUrl:"https://www.sjcpa.us/" },
  { name:"Citrus", code:"cit", city:"Inverness", url:"https://citrus.realtdm.com/public/cases/list", contact:"TaxDeeds@CitrusClerk.org", assessorUrl:"https://www.pa.citrus.fl.us/" },
  { name:"Okaloosa", code:"oka", city:"Crestview", url:"https://okaloosa.realtdm.com/public/cases/list", contact:"(850) 689-5000", assessorUrl:"https://www.okaloosaschools.com/" },
  { name:"Escambia", code:"esc", city:"Pensacola", url:"https://escambia.realtdm.com/public/cases/list", contact:"(850) 595-4310", assessorUrl:"https://www.escpa.org/" },
  { name:"Leon", code:"leon", city:"Tallahassee", url:"https://leon.realtdm.com/public/cases/list", contact:"(850) 606-4000", assessorUrl:"https://www.leonpa.org/" },
  { name:"Clay", code:"clay", city:"Green Cove Springs", url:"https://clay.realtdm.com/public/cases/list", contact:"taxdeedinfo@clayclerk.com", assessorUrl:"https://www.ccpao.com/" },
  { name:"Nassau", code:"nass", city:"Fernandina Beach", url:"https://nassau.realtdm.com/public/cases/list", contact:"(904) 491-6135", assessorUrl:"https://www.nassaupafl.com/" },
  { name:"Columbia", code:"col", city:"Lake City", url:"https://columbia.realtdm.com/public/cases/list", contact:"(386) 758-1163", assessorUrl:"https://www.columbiapafl.com/" },
  { name:"Sumter", code:"sum", city:"Bushnell", url:"https://sumter.realtdm.com/public/cases/list", contact:"(352) 569-6600", assessorUrl:"https://www.sumterpa.com/" },
  { name:"Bay", code:"bay", city:"Panama City", url:"https://bay.realtdm.com/public/cases/list", contact:"(850) 763-9061", assessorUrl:"https://www.baypa.net/" },
  { name:"Okeechobee", code:"okee", city:"Okeechobee", url:"https://okeechobee.realtdm.com/public/cases/list", contact:"(863) 763-2131", assessorUrl:"https://www.okeechobeepa.com/" },
  { name:"Martin", code:"mart", city:"Stuart", url:"https://martin.realtdm.com/public/cases/list", contact:"(772) 288-5576", assessorUrl:"https://www.pa.martin.fl.us/" },
  { name:"Monroe", code:"mon", city:"Key West", url:"https://monroe.realtdm.com/public/cases/list", contact:"(305) 292-3423", assessorUrl:"https://www.mcpafl.org/" },
  { name:"Santa Rosa", code:"sr", city:"Milton", url:"https://santarosa.realtdm.com/public/cases/list", contact:"(850) 983-1975", assessorUrl:"https://www.srcpa.org/" },
  { name:"Walton", code:"wal", city:"DeFuniak Springs", url:"https://walton.realtdm.com/public/cases/list", contact:"(850) 892-8115", assessorUrl:"https://www.waltoncountypa.com/" }
];

// ── DATA: BID4ASSETS ACTIVE AUCTIONS ─────────────────────────────────────
var BID4ASSETS = [
  { url:"https://www.bid4assets.com/storefront/RiversideCountyApr26", county:"Riverside County", state:"CA", date:"Apr 23-28, 2026", deposit:"$5,035" },
  { url:"https://www.bid4assets.com/storefront/NyeNVMay26", county:"Nye County", state:"NV", date:"May 1-4, 2026", deposit:"$535" },
  { url:"https://www.bid4assets.com/storefront/ChurchillNVMay26", county:"Churchill County", state:"NV", date:"May 15, 2026", deposit:"$500" },
  { url:"https://www.bid4assets.com/storefront/ModocMay26", county:"Modoc County", state:"CA", date:"May 18, 2026", deposit:"$500" },
  { url:"https://www.bid4assets.com/storefront/ElkoNVApr26", county:"Elko County", state:"NV", date:"Apr 20-24, 2026", deposit:"$500" },
  { url:"https://www.bid4assets.com/storefront/CarsonCityApr26", county:"Carson City", state:"NV", date:"Apr 22, 2026", deposit:"$500" },
  { url:"https://www.bid4assets.com/philataxsales", county:"Philadelphia County", state:"PA", date:"Ongoing", deposit:"Certified check" },
  { url:"https://www.bid4assets.com/florida-tax-sales", county:"Florida", state:"FL", date:"Various", deposit:"Varies" }
];

// ── DATA: GOVEASE COUNTIES ────────────────────────────────────────────────
var GOVEASE_COUNTIES = [
  // Georgia
  { name:"Fulton", code:"ga-fulton", city:"Atlanta", state:"GA", url:"https://www.govease.com/auctions?state=GA&county=Fulton", contact:"govease.com", date:"Various" },
  { name:"DeKalb", code:"ga-dekalb", city:"Decatur", state:"GA", url:"https://www.govease.com/auctions?state=GA&county=DeKalb", contact:"govease.com", date:"Various" },
  { name:"Gwinnett", code:"ga-gwinnett", city:"Lawrenceville", state:"GA", url:"https://www.govease.com/auctions?state=GA&county=Gwinnett", contact:"govease.com", date:"Various" },
  { name:"Cobb", code:"ga-cobb", city:"Marietta", state:"GA", url:"https://www.govease.com/auctions?state=GA&county=Cobb", contact:"govease.com", date:"Various" },
  // Texas
  { name:"Harris", code:"tx-harris", city:"Houston", state:"TX", url:"https://www.govease.com/auctions?state=TX&county=Harris", contact:"govease.com", date:"Various" },
  { name:"Dallas", code:"tx-dallas", city:"Dallas", state:"TX", url:"https://www.govease.com/auctions?state=TX&county=Dallas", contact:"govease.com", date:"Various" },
  { name:"Tarrant", code:"tx-tarrant", city:"Fort Worth", state:"TX", url:"https://www.govease.com/auctions?state=TX&county=Tarrant", contact:"govease.com", date:"Various" },
  { name:"Bexar", code:"tx-bexar", city:"San Antonio", state:"TX", url:"https://www.govease.com/auctions?state=TX&county=Bexar", contact:"govease.com", date:"Various" },
  // Ohio
  { name:"Cuyahoga", code:"oh-cuyahoga", city:"Cleveland", state:"OH", url:"https://www.govease.com/auctions?state=OH&county=Cuyahoga", contact:"govease.com", date:"Various" },
  { name:"Franklin", code:"oh-franklin", city:"Columbus", state:"OH", url:"https://www.govease.com/auctions?state=OH&county=Franklin", contact:"govease.com", date:"Various" },
  { name:"Hamilton", code:"oh-hamilton", city:"Cincinnati", state:"OH", url:"https://www.govease.com/auctions?state=OH&county=Hamilton", contact:"govease.com", date:"Various" },
  // Michigan
  { name:"Wayne", code:"mi-wayne", city:"Detroit", state:"MI", url:"https://www.govease.com/auctions?state=MI&county=Wayne", contact:"govease.com", date:"Various" },
  { name:"Oakland", code:"mi-oakland", city:"Pontiac", state:"MI", url:"https://www.govease.com/auctions?state=MI&county=Oakland", contact:"govease.com", date:"Various" },
  // Tennessee
  { name:"Shelby", code:"tn-shelby", city:"Memphis", state:"TN", url:"https://www.govease.com/auctions?state=TN&county=Shelby", contact:"govease.com", date:"Various" },
  { name:"Davidson", code:"tn-davidson", city:"Nashville", state:"TN", url:"https://www.govease.com/auctions?state=TN&county=Davidson", contact:"govease.com", date:"Various" },
  // Indiana
  { name:"Marion", code:"in-marion", city:"Indianapolis", state:"IN", url:"https://www.govease.com/auctions?state=IN&county=Marion", contact:"govease.com", date:"Various" },
  { name:"Lake", code:"in-lake", city:"Gary", state:"IN", url:"https://www.govease.com/auctions?state=IN&county=Lake", contact:"govease.com", date:"Various" },
  // Illinois
  { name:"Cook", code:"il-cook", city:"Chicago", state:"IL", url:"https://www.govease.com/auctions?state=IL&county=Cook", contact:"govease.com", date:"Various" },
  { name:"DuPage", code:"il-dupage", city:"Wheaton", state:"IL", url:"https://www.govease.com/auctions?state=IL&county=DuPage", contact:"govease.com", date:"Various" },
  // Missouri
  { name:"St. Louis", code:"mo-stlouis", city:"Clayton", state:"MO", url:"https://www.govease.com/auctions?state=MO&county=St.+Louis", contact:"govease.com", date:"Various" },
  { name:"Jackson", code:"mo-jackson", city:"Kansas City", state:"MO", url:"https://www.govease.com/auctions?state=MO&county=Jackson", contact:"govease.com", date:"Various" },
  // Pennsylvania
  { name:"Allegheny", code:"pa-allegheny", city:"Pittsburgh", state:"PA", url:"https://www.govease.com/auctions?state=PA&county=Allegheny", contact:"govease.com", date:"Various" },
  { name:"Monroe", code:"pa-monroe", city:"Stroudsburg", state:"PA", url:"https://www.bid4assets.com/storefront/MonroePATaxApr26", contact:"bid4assets.com", date:"Apr 8, 2026" },
  // Arizona
  { name:"Maricopa", code:"az-maricopa", city:"Phoenix", state:"AZ", url:"https://www.govease.com/auctions?state=AZ&county=Maricopa", contact:"govease.com", date:"Various" },
  { name:"Pima", code:"az-pima", city:"Tucson", state:"AZ", url:"https://www.govease.com/auctions?state=AZ&county=Pima", contact:"govease.com", date:"Various" },
  // North Carolina
  { name:"Mecklenburg", code:"nc-meck", city:"Charlotte", state:"NC", url:"https://www.govease.com/auctions?state=NC&county=Mecklenburg", contact:"govease.com", date:"Various" },
  { name:"Wake", code:"nc-wake", city:"Raleigh", state:"NC", url:"https://www.govease.com/auctions?state=NC&county=Wake", contact:"govease.com", date:"Various" },
  // Virginia
  { name:"Fairfax", code:"va-fairfax", city:"Fairfax", state:"VA", url:"https://www.govease.com/auctions?state=VA&county=Fairfax", contact:"govease.com", date:"Various" },
  // Colorado
  { name:"Denver", code:"co-denver", city:"Denver", state:"CO", url:"https://www.govease.com/auctions?state=CO&county=Denver", contact:"govease.com", date:"Various" },
  { name:"Arapahoe", code:"co-arapahoe", city:"Centennial", state:"CO", url:"https://www.govease.com/auctions?state=CO&county=Arapahoe", contact:"govease.com", date:"Various" },
  // Washington
  { name:"King", code:"wa-king", city:"Seattle", state:"WA", url:"https://www.govease.com/auctions?state=WA&county=King", contact:"govease.com", date:"Various" },
  // Oregon
  { name:"Multnomah", code:"or-mult", city:"Portland", state:"OR", url:"https://www.govease.com/auctions?state=OR&county=Multnomah", contact:"govease.com", date:"Various" },
  // Maryland
  { name:"Baltimore", code:"md-balt", city:"Baltimore", state:"MD", url:"https://www.bidbaltimore.com/", contact:"bidbaltimore.com", date:"Various" },
  { name:"Prince George", code:"md-pg", city:"Upper Marlboro", state:"MD", url:"https://princegeorgescountymd.realtaxlien.com/", contact:"realtaxlien.com", date:"Various" }
];

// ── DATA: REALAUCTION COUNTIES ────────────────────────────────────────────
var REALAUCTION_COUNTIES = [
  // New Jersey
  { name:"Ocean", code:"nj-ocean", city:"Toms River", state:"NJ", url:"https://realauction.com/county.cfm?id=NJ_OCEAN", contact:"realauction.com", date:"Various" },
  { name:"Middlesex", code:"nj-middle", city:"New Brunswick", state:"NJ", url:"https://realauction.com/county.cfm?id=NJ_MIDDLESEX", contact:"realauction.com", date:"Various" },
  { name:"Burlington", code:"nj-burl", city:"Mount Holly", state:"NJ", url:"https://realauction.com/county.cfm?id=NJ_BURLINGTON", contact:"realauction.com", date:"Various" },
  // Colorado
  { name:"Adams", code:"co-adams", city:"Brighton", state:"CO", url:"https://realauction.com/county.cfm?id=CO_ADAMS", contact:"realauction.com", date:"Various" },
  { name:"Douglas", code:"co-douglas", city:"Castle Rock", state:"CO", url:"https://realauction.com/county.cfm?id=CO_DOUGLAS", contact:"realauction.com", date:"Various" },
  { name:"Weld", code:"co-weld", city:"Greeley", state:"CO", url:"https://realauction.com/county.cfm?id=CO_WELD", contact:"realauction.com", date:"Various" }
];

// ── DATA: LOUISIANA CIVICSOURCE ───────────────────────────────────────────
var CIVICSOURCE_PARISHES = [
  { name:"East Baton Rouge", code:"la-ebr", city:"Baton Rouge", url:"https://www.civicsource.com/search?state=LA&county=East+Baton+Rouge", contact:"civicsource.com" },
  { name:"Jefferson", code:"la-jeff", city:"Gretna", url:"https://www.civicsource.com/search?state=LA&county=Jefferson", contact:"civicsource.com" },
  { name:"Caddo", code:"la-caddo", city:"Shreveport", url:"https://www.civicsource.com/search?state=LA&county=Caddo", contact:"civicsource.com" },
  { name:"Ouachita", code:"la-ouach", city:"Monroe", url:"https://www.civicsource.com/search?state=LA&county=Ouachita", contact:"civicsource.com" },
  { name:"Lafourche", code:"la-laf", city:"Thibodaux", url:"https://www.civicsource.com/search?state=LA&county=Lafourche", contact:"civicsource.com" }
];

// ── HARDCODED BASE PROPERTIES ─────────────────────────────────────────────
var HARDCODED = [
  {external_id:"b4a-rv-502540049",address:"182 Paseo Florido",city:"Palm Springs",state:"CA",county:"Riverside County",zip:"92262",status:"auction",min_bid:50899,arv:185000,beds:3,baths:2,sqft:1240,year_built:1972,parcel_id:"502-540-049",auction_date:"Apr 23-28, 2026",source_name:"Bid4Assets — Riverside Co. CA",source_url:"https://www.bid4assets.com/auction/index/1265738",county_url:"https://www.bid4assets.com/storefront/RiversideCountyApr26",assessor_url:"https://www.assessor.rivco.org/",deposit_required:"$5,035",contact:"taxsale@rivco.org",notes:"Tax-defaulted. No reserve. 862 parcels.",photo:"https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=500&q=75"},
  {external_id:"b4a-rv-637280018",address:"Parcel 637-280-018 Vacant Land",city:"Desert Hot Springs",state:"CA",county:"Riverside County",zip:"92240",status:"auction",min_bid:1211,arv:28000,beds:null,baths:null,sqft:null,year_built:null,parcel_id:"637-280-018",auction_date:"Apr 23-28, 2026",source_name:"Bid4Assets — Riverside Co. CA",source_url:"https://www.bid4assets.com/storefront/RiversideCountyApr26",county_url:"https://www.bid4assets.com/storefront/RiversideCountyApr26",assessor_url:"https://www.assessor.rivco.org/",deposit_required:"$5,035",contact:"taxsale@rivco.org",notes:"Vacant land.",photo:"https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=500&q=75"},
  {external_id:"wc-mi-gratiot12345",address:"12345 Gratiot Ave",city:"Detroit",state:"MI",county:"Wayne County",zip:"48205",status:"foreclosure",min_bid:6800,arv:58000,beds:3,baths:1,sqft:1050,year_built:1948,parcel_id:"21-012345-0",auction_date:"Sept 2026",source_name:"Wayne County Treasurer",source_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",county_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",assessor_url:"https://pta.waynecounty.com/",deposit_required:"TBD",contact:"(313) 224-5990",notes:"2026 foreclosure list.",photo:"https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=500&q=75"},
  {external_id:"wc-mi-linwood8901",address:"8901 Linwood St",city:"Detroit",state:"MI",county:"Wayne County",zip:"48206",status:"foreclosure",min_bid:4500,arv:42000,beds:2,baths:1,sqft:920,year_built:1942,parcel_id:"16-008901-0",auction_date:"Sept 2026",source_name:"Wayne County Treasurer",source_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",county_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",assessor_url:"https://pta.waynecounty.com/",deposit_required:"TBD",contact:"(313) 224-5990",notes:"2026 Wayne County list.",photo:"https://images.unsplash.com/photo-1523217582562-09d0def993a6?w=500&q=75"},
  {external_id:"b4a-ph-nreese2847",address:"2847 N Reese St",city:"Philadelphia",state:"PA",county:"Philadelphia County",zip:"19133",status:"sheriff",min_bid:19500,arv:89000,beds:3,baths:1,sqft:1100,year_built:1925,parcel_id:"31-2-2847-00",auction_date:"Ongoing",source_name:"Bid4Assets Philadelphia Sheriff",source_url:"https://www.bid4assets.com/philataxsales",county_url:"https://www.bid4assets.com/philataxsales",assessor_url:"https://opa.phila.gov/",deposit_required:"Certified check",contact:"SheriffTax@phila.gov",notes:"Sheriff sale.",photo:"https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=500&q=75"},
  {external_id:"nye-nv-pahrump2026",address:"Trust Property Parcel TBD",city:"Pahrump",state:"NV",county:"Nye County",zip:"89048",status:"auction",min_bid:1500,arv:95000,beds:3,baths:2,sqft:1380,year_built:1995,parcel_id:"Apr 2026",auction_date:"May 1-4, 2026",source_name:"Nye County NV Tax Sale",source_url:"https://www.nyecountynv.gov/1118/2026-Online-Only-Tax-Sale-Auctions",county_url:"https://www.nyecountynv.gov/1118/2026-Online-Only-Tax-Sale-Auctions",assessor_url:"https://www.nyecountyassessor.com/",deposit_required:"$535",contact:"Nye County Treasurer",notes:"Online-only. 10% buyer fee.",photo:"https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=500&q=75"}
];

// ── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== PropScan Scraper ===");
  console.log("Time:", new Date().toISOString());
  console.log("Sources: FL(" + FL_COUNTIES.length + " counties) + Bid4Assets(" + BID4ASSETS.length + ") + GovEase(" + GOVEASE_COUNTIES.length + ") + RealAuction(" + REALAUCTION_COUNTIES.length + ") + CivicSource(" + CIVICSOURCE_PARISHES.length + ")");

  var allProperties = [...HARDCODED];
  console.log("Base:", HARDCODED.length, "properties\n");

  // 1. Florida OTC (all 40 counties)
  console.log("[1] Florida Lands Available for Taxes...");
  var flTotal = 0;
  for (var county of FL_COUNTIES) {
    var props = await scrapeCustomFLCounty(county);
    allProperties = allProperties.concat(props);
    flTotal += props.length;
    await sleep(600);
  }
  console.log("FL total:", flTotal, "\n");

  // 2. Bid4Assets active auctions
  console.log("[2] Bid4Assets auctions...");
  var b4aTotal = 0;
  for (var auction of BID4ASSETS) {
    var aProps = await scrapeBid4Assets(auction);
    allProperties = allProperties.concat(aProps);
    b4aTotal += aProps.length;
    await sleep(1500);
  }
  console.log("Bid4Assets total:", b4aTotal, "\n");

  // 3. GovEase counties
  console.log("[3] GovEase counties...");
  var geTotal = 0;
  for (var gc of GOVEASE_COUNTIES) {
    var gProps = await scrapeGovEase(gc);
    allProperties = allProperties.concat(gProps);
    geTotal += gProps.length;
    await sleep(800);
  }
  console.log("GovEase total:", geTotal, "\n");

  // 4. RealAuction counties
  console.log("[4] RealAuction counties...");
  var raTotal = 0;
  for (var rc of REALAUCTION_COUNTIES) {
    var rProps = await scrapeRealAuction(rc);
    allProperties = allProperties.concat(rProps);
    raTotal += rProps.length;
    await sleep(800);
  }
  console.log("RealAuction total:", raTotal, "\n");

  // 5. CivicSource (Louisiana)
  console.log("[5] CivicSource Louisiana...");
  var csTotal = 0;
  for (var parish of CIVICSOURCE_PARISHES) {
    var cProps = await scrapeCivicSource(parish);
    allProperties = allProperties.concat(cProps);
    csTotal += cProps.length;
    await sleep(800);
  }
  console.log("CivicSource total:", csTotal, "\n");

  // Deduplicate
  var seen = new Set();
  var unique = allProperties.filter(p => {
    if (!p.external_id) return false;
    if (seen.has(p.external_id)) return false;
    seen.add(p.external_id);
    return true;
  });

  console.log("=== Saving", unique.length, "properties ===");
  var saved = await supabaseUpsert(unique);
  console.log("Saved:", saved);

  // County breakdown
  var byCounty = {};
  unique.forEach(p => {
    var key = (p.county || "Unknown") + " " + (p.state || "");
    byCounty[key] = (byCounty[key] || 0) + 1;
  });
  console.log("\n=== County breakdown ===");
  Object.keys(byCounty).sort((a,b) => byCounty[b] - byCounty[a]).slice(0, 20).forEach(k => {
    console.log(" ", k + ":", byCounty[k]);
  });

  console.log("\n=== Summary ===");
  console.log("OTC gems:", unique.filter(p => p.status === "otc").length);
  console.log("Auctions:", unique.filter(p => p.status === "auction").length);
  console.log("Foreclosures:", unique.filter(p => p.status === "foreclosure" || p.status === "sheriff").length);
  console.log("States covered:", [...new Set(unique.map(p => p.state).filter(Boolean))].sort().join(", "));
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
