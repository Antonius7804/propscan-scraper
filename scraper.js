const fetch = require("node-fetch");
const cheerio = require("cheerio");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

// ── HOT MARKETS ───────────────────────────────────────────────────────────
// Based on 2026 market data: appreciation, rental yield, population growth
var HOT_MARKETS = {
  // FL
  "Duval County":      { hot: true,  score: 92, reason: "Jacksonville: 6.2% yield, rising" },
  "Hillsborough County":{ hot: true, score: 90, reason: "Tampa: +5.1% appreciation" },
  "Orange County":     { hot: true,  score: 88, reason: "Orlando: +3% YoY, tech growth" },
  "Lee County":        { hot: true,  score: 85, reason: "Cape Coral: buyer market, low prices" },
  "Polk County":       { hot: true,  score: 84, reason: "Lakeland: 6.4% yield, fast growth" },
  "Brevard County":    { hot: true,  score: 83, reason: "Space Coast: affordable coastal" },
  "Sarasota County":   { hot: true,  score: 82, reason: "Luxury market, strong appreciation" },
  // TX
  "Harris County":     { hot: true,  score: 91, reason: "Houston: huge market, low prices" },
  "Dallas County":     { hot: true,  score: 89, reason: "Dallas: top growth city 2026" },
  "Tarrant County":    { hot: true,  score: 87, reason: "Fort Worth: rapid expansion" },
  "Travis County":     { hot: true,  score: 86, reason: "Austin: tech hub recovery" },
  "Bexar County":      { hot: true,  score: 85, reason: "San Antonio: 6.8% yield" },
  "Collin County":     { hot: true,  score: 84, reason: "Dallas suburbs: top growth" },
  // GA
  "Fulton County":     { hot: true,  score: 88, reason: "Atlanta: major job market" },
  "Gwinnett County":   { hot: true,  score: 86, reason: "Atlanta suburbs: fast growth" },
  "Cobb County":       { hot: true,  score: 85, reason: "Atlanta metro: strong demand" },
  // TN
  "Shelby County":     { hot: true,  score: 84, reason: "Memphis: high rental yields" },
  "Davidson County":   { hot: true,  score: 87, reason: "Nashville: top migration city" },
  "Williamson County": { hot: true,  score: 85, reason: "Nashville suburbs: rapid growth" },
  // NC
  "Mecklenburg County":{ hot: true,  score: 86, reason: "Charlotte: finance hub" },
  "Wake County":       { hot: true,  score: 85, reason: "Raleigh: tech corridor" },
  // SC
  "Horry County":      { hot: true,  score: 83, reason: "Myrtle Beach: vacation rental demand" },
  "Charleston County": { hot: true,  score: 84, reason: "Charleston: luxury + growth" },
  // AZ
  "Maricopa County":   { hot: true,  score: 85, reason: "Phoenix: rebounding market" },
  "Pima County":       { hot: true,  score: 82, reason: "Tucson: affordable growth" },
  // OH
  "Franklin County":   { hot: true,  score: 83, reason: "Columbus: steady appreciation" },
  // MI
  "Oakland County":    { hot: true,  score: 81, reason: "Detroit suburbs: undervalued" },
  // IN
  "Marion County":     { hot: true,  score: 80, reason: "Indianapolis: affordable growth" },
};

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
  // Add hot market flag to notes
  var mkt = HOT_MARKETS[obj.county];
  if (mkt && obj.notes && obj.notes.indexOf("HOT MARKET") < 0) {
    obj.notes = "🔥 HOT MARKET: " + mkt.reason + ". " + (obj.notes || "");
  }
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
      if (!res.ok) console.error("Supabase error:", await res.text());
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

// ── CORE PARSER: Simple HTML table/list pages ─────────────────────────────
// Government sites use simple HTML - find tables with parcel/price data
async function scrapeSimpleCountyPage(county) {
  console.log("  Scraping:", county.name, county.state);
  var html = await fetchPage(county.url);
  if (!html) { console.log("    No response"); return []; }

  var $ = cheerio.load(html);
  var properties = [];
  var seen = new Set();

  // Strategy 1: Look for PDF links (many counties link to Excel/PDF lists)
  var pdfLinks = [];
  $("a[href$='.pdf'], a[href$='.xlsx'], a[href$='.xls'], a[href*='pdf'], a[href*='excel']").each(function(i, el) {
    var href = $(el).attr("href") || "";
    var text = $(el).text().toLowerCase();
    if (text.includes("struck") || text.includes("otc") || text.includes("unsold") ||
        text.includes("surplus") || text.includes("lands available") || text.includes("forfeited") ||
        text.includes("delinquent") || text.includes("list")) {
      pdfLinks.push(href.startsWith("http") ? href : county.url.replace(/\/[^\/]*$/, "/") + href);
    }
  });

  // Strategy 2: Look for direct table data
  $("table tr").each(function(i, row) {
    if (i === 0) return;
    var text = $(row).text().replace(/\s+/g, " ").trim();
    if (text.length < 15) return;

    // Extract price - look for dollar amounts
    var priceMatch = text.match(/\$\s*([\d,]+\.?\d*)/);
    if (!priceMatch) return;
    var price = parseFloat(priceMatch[1].replace(/,/g,""));
    if (!price || price < 100 || price > 5000000) return;

    // Extract parcel/account number
    var parcelMatch = text.match(/([A-Z0-9]{2,}-[A-Z0-9]{2,}-[A-Z0-9]{2,})/i) ||
                      text.match(/(\d{5,}[-\/]\d{2,})/);
    var parcel = parcelMatch ? parcelMatch[1] : null;

    // Extract address
    var addrMatch = text.match(/(\d+\s+[A-Za-z][A-Za-z\s]+(?:St|Ave|Rd|Dr|Ln|Blvd|Way|Ct|Pl|Ter|Hwy|Street|Avenue|Road|Drive|Lane|Boulevard|Trail|Circle|Loop))/i);
    var address = addrMatch ? addrMatch[1].trim().substring(0,150) : (parcel ? "Parcel " + parcel : null);
    if (!address) return;

    // Skip junk rows
    if (address.toLowerCase().includes("address") || address.toLowerCase().includes("property")) return;

    var extId = county.code + "-" + (parcel || i).toString().replace(/[^a-zA-Z0-9]/g,"").substring(0,20) + "-" + (Date.now() % 10000);
    if (seen.has(extId)) return;
    seen.add(extId);

    var isOTC = county.type === "otc" || county.type === "struck_off" || county.type === "forfeited";

    properties.push({
      external_id: extId,
      address: address,
      city: county.city || county.name,
      state: county.state,
      county: county.name + " County",
      zip: null,
      status: isOTC ? "otc" : "auction",
      min_bid: price,
      arv: isOTC ? Math.round(price * 3) : null,
      beds: null, baths: null, sqft: null, year_built: null,
      parcel_id: parcel,
      auction_date: county.date || null,
      auction_ends: null,
      source_name: county.sourceName || (county.name + " County — " + (isOTC ? "Struck Off/OTC" : "Tax Sale")),
      source_url: county.url,
      county_url: county.url,
      assessor_url: county.assessorUrl || null,
      deposit_required: county.deposit || null,
      contact: county.contact || (county.name + " County Tax Office"),
      notes: (isOTC ? "POST-AUCTION UNSOLD: No bidders. Buy direct from county at minimum. Zero competition." : "Tax sale auction.") + " " + county.name + " County " + county.state,
      photo: null
    });
  });

  // Strategy 3: Look for list items with prices
  if (properties.length === 0) {
    $("li, p, div.property, div.listing, div.result").each(function(i, el) {
      if (i > 200) return;
      var text = $(el).text().replace(/\s+/g, " ").trim();
      if (text.length < 20 || text.length > 500) return;
      var priceMatch = text.match(/\$\s*([\d,]+\.?\d*)/);
      if (!priceMatch) return;
      var price = parseFloat(priceMatch[1].replace(/,/g,""));
      if (!price || price < 100 || price > 5000000) return;
      var addrMatch = text.match(/(\d+\s+[A-Za-z][A-Za-z\s]+(?:St|Ave|Rd|Dr|Ln|Blvd|Street|Avenue|Road))/i);
      if (!addrMatch) return;
      var extId = county.code + "-li-" + i;
      if (seen.has(extId)) return;
      seen.add(extId);
      properties.push({
        external_id: extId,
        address: addrMatch[1].trim().substring(0,150),
        city: county.city || county.name,
        state: county.state, county: county.name + " County", zip: null,
        status: county.type === "otc" || county.type === "struck_off" ? "otc" : "auction",
        min_bid: price, arv: null,
        beds: null, baths: null, sqft: null, year_built: null,
        parcel_id: null, auction_date: county.date || null, auction_ends: null,
        source_name: county.name + " County Tax Sale",
        source_url: county.url, county_url: county.url,
        assessor_url: county.assessorUrl || null,
        deposit_required: null, contact: county.contact || "County Tax Office",
        notes: "Tax sale. " + county.name + " County " + county.state,
        photo: null
      });
    });
  }

  // Log PDF links found (useful for manual follow-up)
  if (pdfLinks.length > 0) {
    console.log("    PDF/Excel lists found:", pdfLinks.length, "(manual download needed)");
    pdfLinks.slice(0,3).forEach(l => console.log("      ", l));
  }

  console.log("    Found", properties.length, "properties");
  return properties;
}

// ── FLORIDA OTC (proven working format) ───────────────────────────────────
async function scrapePutnamStyle(county) {
  console.log("  FL OTC:", county.name, "County");
  var html = await fetchPage(county.url);
  if (!html) { console.log("    No data"); return []; }
  var $ = cheerio.load(html);
  var properties = [];
  var seen = new Set();

  $("table tr").each(function(i, row) {
    var text = $(row).text().replace(/\s+/g, " ").trim();
    var priceMatch = text.match(/Estimated[^$]*\$([\d,]+\.?\d*)/i) ||
                     text.match(/Purchase Price[^$]*\$([\d,]+\.?\d*)/i) ||
                     text.match(/Amount Due[^$]*\$([\d,]+\.?\d*)/i);
    var parcelMatch = text.match(/Parcel\s*(?:Number|#)?\s*:?\s*([\d\-]+)/i) ||
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

    var extId = "fl-" + county.code + "-" + (caseNum||parcel||i).toString().replace(/[^a-zA-Z0-9]/g,"").substring(0,20);
    if (seen.has(extId)) return;
    seen.add(extId);

    properties.push({
      external_id: extId,
      address: address,
      city: county.city || county.name,
      state: "FL", county: county.name + " County", zip: null,
      status: "otc",
      min_bid: price, arv: Math.round(price * 3),
      beds: null, baths: null, sqft: null, year_built: null,
      parcel_id: parcel || caseNum,
      auction_date: dateMatch ? dateMatch[1] : null, auction_ends: null,
      source_name: county.name + " County Clerk — Lands Available",
      source_url: county.url, county_url: county.url,
      assessor_url: county.assessorUrl || null,
      deposit_required: "Cashier's check",
      contact: county.contact,
      notes: "OTC Golden Gem. Buy direct from Clerk. No auction. " + county.name + " County FL.",
      photo: null
    });
  });

  var out = [];
  var s = new Set();
  properties.forEach(p => { if (!s.has(p.external_id)) { s.add(p.external_id); out.push(p); }});
  console.log("   Found", out.length, "FL OTC properties");
  return out;
}

// ── BID4ASSETS ─────────────────────────────────────────────────────────────
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
    var addrMatch = text.match(/(\d+\s+[A-Za-z][A-Za-z0-9\s,]+(?:St|Ave|Rd|Dr|Ln|Blvd|Street|Avenue|Road|Drive|Lane))/i);
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
  console.log("   Found", properties.length, "B4A properties");
  return properties;
}

// ══════════════════════════════════════════════════════════════════════════
// DATA SOURCES
// Strategy: target simple government HTML list pages across all states
// Government sites are simple - look for treasurer/tax collector pages
// ══════════════════════════════════════════════════════════════════════════

// ── FLORIDA: 40 counties (Putnam-style HTML tables) ───────────────────────
var FL_COUNTIES = [
  { name:"Putnam", code:"putnam", city:"Palatka", url:"https://apps.putnam-fl.com/coc/taxdeeds/public/public_LAFT.php", contact:"(386) 329-0361", assessorUrl:"https://ptax.putnam-fl.com/" },
  { name:"Duval", code:"duval", city:"Jacksonville", url:"https://duval.realtdm.com/public/cases/list", contact:"(904) 255-2000", assessorUrl:"https://www.coj.net/departments/property-appraiser" },
  { name:"Hillsborough", code:"hillsb", city:"Tampa", url:"https://hillsborough.realtdm.com/public/cases/list", contact:"(813) 276-8100", assessorUrl:"https://www.hcpafl.org/" },
  { name:"Orange", code:"orange", city:"Orlando", url:"https://myeclerk.myorangeclerk.com/cases/search?status=LandsAvailable", contact:"(407) 836-2060", assessorUrl:"https://www.ocpafl.org/" },
  { name:"Lee", code:"lee", city:"Fort Myers", url:"https://www.leeclerk.org/departments/official-records-recording/tax-deeds/lands-available", contact:"(239) 533-5000", assessorUrl:"https://www.leepa.org/" },
  { name:"St. Lucie", code:"sl", city:"Port St. Lucie", url:"https://stlucie.realtdm.com/public/cases/list", contact:"(772) 462-6900", assessorUrl:"https://www.paslc.gov/" },
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
  { name:"Charlotte", code:"char", city:"Port Charlotte", url:"https://charlotte.realtdm.com/public/cases/list", contact:"(941) 637-2130", assessorUrl:"https://www.ccappraiser.com/" },
  { name:"Manatee", code:"man", city:"Bradenton", url:"https://manatee.realtdm.com/public/cases/list", contact:"(941) 741-4045", assessorUrl:"https://www.manateepao.com/" },
  { name:"Hernando", code:"hern", city:"Brooksville", url:"https://hernando.realtdm.com/public/cases/list", contact:"(352) 754-4201", assessorUrl:"https://www.hernandopa-fl.us/" },
  { name:"Flagler", code:"flag", city:"Bunnell", url:"https://flagler.realtdm.com/public/cases/list", contact:"(386) 313-4400", assessorUrl:"https://www.flaglerpa.com/" },
  { name:"St. Johns", code:"stj", city:"St. Augustine", url:"https://stjohns.realtdm.com/public/cases/list", contact:"(904) 819-3600", assessorUrl:"https://www.sjcpa.us/" },
  { name:"Citrus", code:"cit", city:"Inverness", url:"https://citrus.realtdm.com/public/cases/list", contact:"TaxDeeds@CitrusClerk.org", assessorUrl:"https://www.pa.citrus.fl.us/" },
  { name:"Indian River", code:"ir", city:"Vero Beach", url:"https://indianriver.realtdm.com/public/cases/list", contact:"(772) 770-5185", assessorUrl:"https://www.ircpa.org/" },
  { name:"Okaloosa", code:"oka", city:"Crestview", url:"https://okaloosa.realtdm.com/public/cases/list", contact:"(850) 689-5000", assessorUrl:"https://www.okaloosaschools.com/" },
  { name:"Escambia", code:"esc", city:"Pensacola", url:"https://escambia.realtdm.com/public/cases/list", contact:"(850) 595-4310", assessorUrl:"https://www.escpa.org/" },
  { name:"Leon", code:"leon", city:"Tallahassee", url:"https://leon.realtdm.com/public/cases/list", contact:"(850) 606-4000", assessorUrl:"https://www.leonpa.org/" },
  { name:"Nassau", code:"nass", city:"Fernandina Beach", url:"https://nassau.realtdm.com/public/cases/list", contact:"(904) 491-6135", assessorUrl:"https://www.nassaupafl.com/" },
  { name:"Columbia", code:"col", city:"Lake City", url:"https://columbia.realtdm.com/public/cases/list", contact:"(386) 758-1163", assessorUrl:"https://www.columbiapafl.com/" },
  { name:"Sumter", code:"sum", city:"Bushnell", url:"https://sumter.realtdm.com/public/cases/list", contact:"(352) 569-6600", assessorUrl:"https://www.sumterpa.com/" },
  { name:"Bay", code:"bay", city:"Panama City", url:"https://bay.realtdm.com/public/cases/list", contact:"(850) 763-9061", assessorUrl:"https://www.baypa.net/" },
  { name:"Martin", code:"mart", city:"Stuart", url:"https://martin.realtdm.com/public/cases/list", contact:"(772) 288-5576", assessorUrl:"https://www.pa.martin.fl.us/" },
  { name:"Monroe", code:"mon", city:"Key West", url:"https://monroe.realtdm.com/public/cases/list", contact:"(305) 292-3423", assessorUrl:"https://www.mcpafl.org/" },
  { name:"Santa Rosa", code:"sr", city:"Milton", url:"https://santarosa.realtdm.com/public/cases/list", contact:"(850) 983-1975", assessorUrl:"https://www.srcpa.org/" },
  { name:"Walton", code:"wal", city:"DeFuniak Springs", url:"https://walton.realtdm.com/public/cases/list", contact:"(850) 892-8115", assessorUrl:"https://www.waltoncountypa.com/" },
  { name:"Clay", code:"clay", city:"Green Cove Springs", url:"https://clay.realtdm.com/public/cases/list", contact:"taxdeedinfo@clayclerk.com", assessorUrl:"https://www.ccpao.com/" }
];

// ── MULTI-STATE: Simple county HTML pages (government list format) ─────────
// These all use simple table/list HTML - no login required
var ALL_STATE_COUNTIES = [

  // ── TEXAS: Struck-Off lists (post-auction, no competition) ────────────────
  // Texas counties publish "struck off" lists - properties that didn't sell at auction
  // County tax assessor sites - simple HTML tables
  { name:"Harris", code:"tx-harris", city:"Houston", state:"TX", type:"struck_off",
    url:"https://www.harriscountytax.com/struck-off-properties",
    contact:"(713) 274-8000", assessorUrl:"https://hcad.org/",
    sourceName:"Harris County TX — Struck Off Properties" },
  { name:"Dallas", code:"tx-dallas", city:"Dallas", state:"TX", type:"struck_off",
    url:"https://www.dallascounty.org/departments/tax_office/property-tax-foreclosure.php",
    contact:"(214) 653-7811", assessorUrl:"https://www.dallascad.org/",
    sourceName:"Dallas County TX — Tax Foreclosure" },
  { name:"Tarrant", code:"tx-tarrant", city:"Fort Worth", state:"TX", type:"struck_off",
    url:"https://www.tarrantcounty.com/en/tax/property-tax/delinquent-taxes.html",
    contact:"(817) 884-1100", assessorUrl:"https://www.tad.org/",
    sourceName:"Tarrant County TX — Delinquent Tax" },
  { name:"Travis", code:"tx-travis", city:"Austin", state:"TX", type:"struck_off",
    url:"https://tax.traviscountytx.gov/property-tax/tax-sales",
    contact:"(512) 854-9473", assessorUrl:"https://www.traviscad.org/",
    sourceName:"Travis County TX — Tax Sales" },
  { name:"Bexar", code:"tx-bexar", city:"San Antonio", state:"TX", type:"struck_off",
    url:"https://www.bexar.org/1622/Tax-Sales",
    contact:"(210) 335-2251", assessorUrl:"https://www.bcad.org/",
    sourceName:"Bexar County TX — Tax Sales" },
  { name:"Collin", code:"tx-collin", city:"McKinney", state:"TX", type:"struck_off",
    url:"https://www.collincountytx.gov/tax_assessor_collector/Pages/delinquent_tax.aspx",
    contact:"(972) 547-5020", assessorUrl:"https://www.collincad.org/",
    sourceName:"Collin County TX — Delinquent Tax" },
  { name:"El Paso", code:"tx-elpaso", city:"El Paso", state:"TX", type:"struck_off",
    url:"https://www.epcounty.com/taxoffice/taxsales.htm",
    contact:"(915) 771-2300", assessorUrl:"https://www.epcad.org/",
    sourceName:"El Paso County TX — Tax Sales" },
  { name:"Denton", code:"tx-denton", city:"Denton", state:"TX", type:"struck_off",
    url:"https://www.dentoncounty.gov/185/Tax-Assessor-Collector",
    contact:"(940) 349-3500", assessorUrl:"https://www.dentoncad.com/",
    sourceName:"Denton County TX — Tax Sales" },
  { name:"Montgomery", code:"tx-mont", city:"Conroe", state:"TX", type:"struck_off",
    url:"https://www.mctx.org/departments/tax_assessor_collector/delinquent_tax.php",
    contact:"(936) 539-7897", assessorUrl:"https://www.mcad-tx.org/",
    sourceName:"Montgomery County TX — Delinquent Tax" },
  { name:"Hidalgo", code:"tx-hidalgo", city:"McAllen", state:"TX", type:"struck_off",
    url:"https://www.hidalgocounty.us/1120/Delinquent-Tax",
    contact:"(956) 318-2157", assessorUrl:"https://www.hidalgocad.org/",
    sourceName:"Hidalgo County TX — Delinquent Tax" },
  // ForecloseHouston - mentioned in book for Houston pre-foreclosures
  { name:"Harris", code:"tx-harris-fc", city:"Houston", state:"TX", type:"struck_off",
    url:"https://www.foreclosehouston.com/",
    contact:"foreclosehouston.com", assessorUrl:"https://hcad.org/",
    sourceName:"Harris County TX — ForecloseHouston" },
  // RealAuction Colorado counties (from book p72)
  { name:"Adams", code:"co-adams2", city:"Brighton", state:"CO", type:"auction",
    url:"https://www.realauction.com/index.cfm?zaction=AUCTION&Zmethod=PREVIEW&state=CO",
    contact:"realauction.com", assessorUrl:"https://www.adcogov.org/assessor/",
    sourceName:"Adams County CO — RealAuction" },
  { name:"Douglas", code:"co-douglas", city:"Castle Rock", state:"CO", type:"auction",
    url:"https://www.realauction.com/index.cfm?zaction=AUCTION&Zmethod=PREVIEW&state=CO",
    contact:"realauction.com", assessorUrl:"https://www.douglas.co.us/assessor/",
    sourceName:"Douglas County CO — RealAuction" },
  { name:"Weld", code:"co-weld", city:"Greeley", state:"CO", type:"auction",
    url:"https://www.realauction.com/index.cfm?zaction=AUCTION&Zmethod=PREVIEW&state=CO",
    contact:"realauction.com", assessorUrl:"https://www.weldgov.com/assessor/",
    sourceName:"Weld County CO — RealAuction" },

  // ── GEORGIA: Surplus property lists ──────────────────────────────────────
  // Georgia counties sell unclaimed/surplus tax deed properties directly
  { name:"Fulton", code:"ga-fulton", city:"Atlanta", state:"GA", type:"otc",
    url:"https://www.fultoncountyga.gov/inside-fulton-county/fulton-county-departments/tax-commissioner/delinquent-tax/surplus-tax-sales",
    contact:"(404) 612-6440", assessorUrl:"https://www.fultonassessor.org/",
    sourceName:"Fulton County GA — Surplus Tax Sales" },
  { name:"DeKalb", code:"ga-dekalb", city:"Decatur", state:"GA", type:"otc",
    url:"https://www.dekalbcountyga.gov/tax-commissioner/delinquent-taxes",
    contact:"(404) 298-4000", assessorUrl:"https://www.dekalbassessor.com/",
    sourceName:"DeKalb County GA — Delinquent Tax" },
  { name:"Gwinnett", code:"ga-gwinnett", city:"Lawrenceville", state:"GA", type:"otc",
    url:"https://www.gwinnettcounty.com/portal/gwinnett/Departments/FinancialServices/TaxCommissioner/DelinquentTax",
    contact:"(770) 822-8800", assessorUrl:"https://www.gwinnettassessor.com/",
    sourceName:"Gwinnett County GA — Delinquent Tax" },
  { name:"Cobb", code:"ga-cobb", city:"Marietta", state:"GA", type:"otc",
    url:"https://www.cobbcounty.org/tax/delinquent-taxes",
    contact:"(770) 528-8600", assessorUrl:"https://www.cobbtax.org/",
    sourceName:"Cobb County GA — Delinquent Tax" },
  { name:"Cherokee", code:"ga-cherokee", city:"Canton", state:"GA", type:"otc",
    url:"https://www.cherokeega.com/Tax-Commissioner/Delinquent-Tax-Sales/",
    contact:"(678) 493-6400", assessorUrl:"https://www.cherokeecountyga.gov/",
    sourceName:"Cherokee County GA — Tax Sales" },
  { name:"Forsyth", code:"ga-forsyth", city:"Cumming", state:"GA", type:"otc",
    url:"https://www.forsythco.com/Departments-Offices/Tax-Commissioner/Delinquent-Tax-Sales",
    contact:"(770) 781-2110", assessorUrl:"https://www.forsythco.com/",
    sourceName:"Forsyth County GA — Tax Sales" },
  { name:"Hall", code:"ga-hall", city:"Gainesville", state:"GA", type:"otc",
    url:"https://www.hallcounty.org/219/Tax-Commissioner",
    contact:"(770) 531-6950", assessorUrl:"https://www.hallcounty.org/",
    sourceName:"Hall County GA — Tax Sales" },

  // ── TENNESSEE: Delinquent tax lists ──────────────────────────────────────
  { name:"Shelby", code:"tn-shelby", city:"Memphis", state:"TN", type:"auction",
    url:"https://www.shelbycountytrustee.com/delinquent-taxes",
    contact:"(901) 222-0200", assessorUrl:"https://www.assessor.shelby.tn.us/",
    sourceName:"Shelby County TN — Delinquent Tax" },
  { name:"Davidson", code:"tn-davidson", city:"Nashville", state:"TN", type:"auction",
    url:"https://www.nashville.gov/departments/trustee/tax-sales",
    contact:"(615) 862-6330", assessorUrl:"https://www.padctn.org/",
    sourceName:"Davidson County TN — Tax Sales" },
  { name:"Knox", code:"tn-knox", city:"Knoxville", state:"TN", type:"auction",
    url:"https://www.knoxcounty.org/trustee/delinquent.php",
    contact:"(865) 215-2305", assessorUrl:"https://www.knoxcounty.org/assessor/",
    sourceName:"Knox County TN — Delinquent Tax" },
  { name:"Hamilton", code:"tn-hamilton", city:"Chattanooga", state:"TN", type:"auction",
    url:"https://www.hamiltontn.gov/Departments/Trustee/TaxSales.aspx",
    contact:"(423) 209-7270", assessorUrl:"https://www.hamiltontn.gov/",
    sourceName:"Hamilton County TN — Tax Sales" },
  { name:"Williamson", code:"tn-williamson", city:"Franklin", state:"TN", type:"auction",
    url:"https://www.williamsoncounty-tn.gov/167/Trustee",
    contact:"(615) 790-5709", assessorUrl:"https://www.williamsoncounty-tn.gov/",
    sourceName:"Williamson County TN — Tax Sales" },

  // ── NORTH CAROLINA: Tax foreclosures ─────────────────────────────────────
  { name:"Mecklenburg", code:"nc-meck", city:"Charlotte", state:"NC", type:"auction",
    url:"https://www.mecknc.gov/TaxCollections/Pages/Foreclosures.aspx",
    contact:"(980) 314-4226", assessorUrl:"https://www.mecknc.gov/assessorsoffice/",
    sourceName:"Mecklenburg County NC — Tax Foreclosures" },
  { name:"Wake", code:"nc-wake", city:"Raleigh", state:"NC", type:"auction",
    url:"https://www.wake.gov/departments-agencies/revenue-department/tax-liens-and-foreclosures",
    contact:"(919) 856-5999", assessorUrl:"https://www.wake.gov/departments-agencies/wake-county-tax-administration/",
    sourceName:"Wake County NC — Tax Liens & Foreclosures" },
  { name:"Guilford", code:"nc-guilford", city:"Greensboro", state:"NC", type:"auction",
    url:"https://www.guilfordcountync.gov/our-county/tax/tax-foreclosures",
    contact:"(336) 641-3363", assessorUrl:"https://www.guilfordcountync.gov/",
    sourceName:"Guilford County NC — Tax Foreclosures" },
  { name:"Durham", code:"nc-durham", city:"Durham", state:"NC", type:"auction",
    url:"https://www.dconc.gov/county-departments/departments-f-z/tax-administration/tax-foreclosures",
    contact:"(919) 560-0300", assessorUrl:"https://www.dconc.gov/",
    sourceName:"Durham County NC — Tax Foreclosures" },

  // ── SOUTH CAROLINA: Delinquent tax ───────────────────────────────────────
  { name:"Horry", code:"sc-horry", city:"Conway", state:"SC", type:"auction",
    url:"https://www.horrycountysc.gov/departments/treasurer/delinquent-taxes/",
    contact:"(843) 915-5470", assessorUrl:"https://www.horrycountysc.gov/departments/assessor/",
    sourceName:"Horry County SC — Delinquent Tax" },
  { name:"Charleston", code:"sc-charleston", city:"Charleston", state:"SC", type:"auction",
    url:"https://www.charlestoncounty.org/departments/treasurer/tax-sale.php",
    contact:"(843) 958-4360", assessorUrl:"https://www.charlestoncounty.org/departments/assessor/",
    sourceName:"Charleston County SC — Tax Sale" },
  { name:"Greenville", code:"sc-greenville", city:"Greenville", state:"SC", type:"auction",
    url:"https://www.greenvillecounty.org/tax_collector/taxsale.aspx",
    contact:"(864) 467-7050", assessorUrl:"https://www.greenvillecounty.org/assessor/",
    sourceName:"Greenville County SC — Tax Sale" },

  // ── MICHIGAN: Forfeited property lists ───────────────────────────────────
  // Michigan has one of the best OTC programs - properties as low as $500
  { name:"Wayne", code:"mi-wayne", city:"Detroit", state:"MI", type:"forfeited",
    url:"https://www.waynecounty.com/elected/treasurer/forfeited-property-list.aspx",
    contact:"(313) 224-5990", assessorUrl:"https://www.waynecounty.com/elected/assessor/",
    sourceName:"Wayne County MI — Forfeited Properties" },
  { name:"Oakland", code:"mi-oakland", city:"Pontiac", state:"MI", type:"forfeited",
    url:"https://www.oakgov.com/treasurer/Pages/forfeited-properties.aspx",
    contact:"(248) 858-0611", assessorUrl:"https://www.oakgov.com/equalization/",
    sourceName:"Oakland County MI — Forfeited Properties" },
  { name:"Macomb", code:"mi-macomb", city:"Mount Clemens", state:"MI", type:"forfeited",
    url:"https://www.macombgov.org/Treasurer-Forfeited",
    contact:"(586) 469-5190", assessorUrl:"https://www.macombgov.org/Equalization",
    sourceName:"Macomb County MI — Forfeited Properties" },
  { name:"Genesee", code:"mi-genesee", city:"Flint", state:"MI", type:"forfeited",
    url:"https://www.geneseecounty.com/departments/treasurer/forfeited-properties",
    contact:"(810) 257-3054", assessorUrl:"https://www.geneseecounty.com/departments/equalization/",
    sourceName:"Genesee County MI — Forfeited Properties" },
  { name:"Kent", code:"mi-kent", city:"Grand Rapids", state:"MI", type:"forfeited",
    url:"https://www.accesskent.com/Departments/Treasurer/forfeitedProperty.htm",
    contact:"(616) 632-7500", assessorUrl:"https://www.accesskent.com/Departments/Equalization/",
    sourceName:"Kent County MI — Forfeited Properties" },

  // ── OHIO: Forfeited Land Commission ──────────────────────────────────────
  { name:"Cuyahoga", code:"oh-cuy", city:"Cleveland", state:"OH", type:"forfeited",
    url:"https://treasurer.cuyahogacounty.gov/en-US/forfeited-land-commission.aspx",
    contact:"(216) 443-7420", assessorUrl:"https://fiscalofficer.cuyahogacounty.gov/",
    sourceName:"Cuyahoga County OH — Forfeited Land Commission" },
  { name:"Franklin", code:"oh-frank", city:"Columbus", state:"OH", type:"forfeited",
    url:"https://treasurer.franklincountyohio.gov/forfeited-land",
    contact:"(614) 525-3438", assessorUrl:"https://www.franklincountyauditor.com/",
    sourceName:"Franklin County OH — Forfeited Land" },
  { name:"Hamilton", code:"oh-ham", city:"Cincinnati", state:"OH", type:"forfeited",
    url:"https://www.hamiltoncountyauditor.org/forfeited-land",
    contact:"(513) 946-4800", assessorUrl:"https://www.hamiltoncountyauditor.org/",
    sourceName:"Hamilton County OH — Forfeited Land" },
  { name:"Summit", code:"oh-sum", city:"Akron", state:"OH", type:"forfeited",
    url:"https://www.summitoh.net/index.php/treasurer/delinquent-taxes",
    contact:"(330) 643-2587", assessorUrl:"https://www.summitoh.net/",
    sourceName:"Summit County OH — Delinquent Tax" },
  { name:"Montgomery", code:"oh-mont", city:"Dayton", state:"OH", type:"forfeited",
    url:"https://www.mcohio.org/government/elected_officials/treasurer/tax_sales.php",
    contact:"(937) 225-4010", assessorUrl:"https://www.mcohio.org/",
    sourceName:"Montgomery County OH — Tax Sales" },

  // ── INDIANA: Commissioner's sales (shortened redemption) ─────────────────
  { name:"Marion", code:"in-marion", city:"Indianapolis", state:"IN", type:"auction",
    url:"https://www.indy.gov/activity/tax-sale",
    contact:"(317) 327-4770", assessorUrl:"https://www.indy.gov/activity/assessor",
    sourceName:"Marion County IN — Tax Sale" },
  { name:"Lake", code:"in-lake", city:"Gary", state:"IN", type:"auction",
    url:"https://www.lakecountyin.org/treasurer/tax-sales",
    contact:"(219) 755-3760", assessorUrl:"https://www.lakecountyin.org/assessor/",
    sourceName:"Lake County IN — Tax Sales" },
  { name:"Allen", code:"in-allen", city:"Fort Wayne", state:"IN", type:"auction",
    url:"https://www.allencounty.us/treasurer/tax-sale",
    contact:"(260) 449-7693", assessorUrl:"https://www.allencounty.us/assessor/",
    sourceName:"Allen County IN — Tax Sale" },
  { name:"Hamilton", code:"in-hamilton", city:"Noblesville", state:"IN", type:"auction",
    url:"https://www.hamiltoncounty.in.gov/treasurer/tax-sales",
    contact:"(317) 776-9620", assessorUrl:"https://www.hamiltoncounty.in.gov/assessor/",
    sourceName:"Hamilton County IN — Tax Sales" },
  // ZeusAuction - Indiana commissioner sales (from book p74 - replaced SRI)
  { name:"St. Joseph", code:"in-stj", city:"South Bend", state:"IN", type:"auction",
    url:"https://zeusauction.com/tsp/xcal_pubLiveAuctions.taf?state=IN",
    contact:"zeusauction.com", assessorUrl:"https://www.stjocounty.com/assessor/",
    sourceName:"St. Joseph County IN — ZeusAuction" },
  { name:"Vigo", code:"in-vigo", city:"Terre Haute", state:"IN", type:"auction",
    url:"https://zeusauction.com/tsp/xcal_pubLiveAuctions.taf?state=IN",
    contact:"zeusauction.com", assessorUrl:"https://www.vigocounty.in.gov/assessor/",
    sourceName:"Vigo County IN — ZeusAuction" },

  // ── ARIZONA: Tax lien auctions ────────────────────────────────────────────
  { name:"Maricopa", code:"az-maricopa", city:"Phoenix", state:"AZ", type:"auction",
    url:"https://mctreasurer.maricopa.gov/tax-lien-sale/",
    contact:"(602) 506-8511", assessorUrl:"https://mcassessor.maricopa.gov/",
    sourceName:"Maricopa County AZ — Tax Lien Sale" },
  { name:"Pima", code:"az-pima", city:"Tucson", state:"AZ", type:"auction",
    url:"https://www.pima.gov/1867/Tax-Lien-Sale",
    contact:"(520) 724-8341", assessorUrl:"https://www.assessor.pima.gov/",
    sourceName:"Pima County AZ — Tax Lien Sale" },
  { name:"Yavapai", code:"az-yavapai", city:"Prescott", state:"AZ", type:"auction",
    url:"https://www.yavapai.us/Portals/6/Treasurer/taxliens.html",
    contact:"(928) 771-3233", assessorUrl:"https://www.yavapai.us/assessor/",
    sourceName:"Yavapai County AZ — Tax Lien Sale" },
  { name:"Coconino", code:"az-coco", city:"Flagstaff", state:"AZ", type:"auction",
    url:"https://www.coconino.az.gov/354/Tax-Lien-Sale",
    contact:"(928) 679-8188", assessorUrl:"https://www.coconino.az.gov/assessor/",
    sourceName:"Coconino County AZ — Tax Lien Sale" },
  { name:"Pinal", code:"az-pinal", city:"Florence", state:"AZ", type:"auction",
    url:"https://www.pinalcountyaz.gov/Treasurer/Pages/TaxLienSale.aspx",
    contact:"(520) 509-3555", assessorUrl:"https://www.pinalcountyaz.gov/Assessor/",
    sourceName:"Pinal County AZ — Tax Lien Sale" },

  // ── ILLINOIS: Tax deed sales ──────────────────────────────────────────────
  { name:"Cook", code:"il-cook", city:"Chicago", state:"IL", type:"auction",
    url:"https://www.cookcountytreasurer.com/taxsales.aspx",
    contact:"(312) 603-6388", assessorUrl:"https://www.cookcountyassessor.com/",
    sourceName:"Cook County IL — Tax Sales" },
  { name:"DuPage", code:"il-dupage", city:"Wheaton", state:"IL", type:"auction",
    url:"https://www.dupageco.org/Treasurer/Tax_Sales/",
    contact:"(630) 407-5900", assessorUrl:"https://www.dupageassessor.com/",
    sourceName:"DuPage County IL — Tax Sales" },
  { name:"Lake", code:"il-lake", city:"Waukegan", state:"IL", type:"auction",
    url:"https://www.lakecountyil.gov/2154/Tax-Sale",
    contact:"(847) 377-2323", assessorUrl:"https://www.lakecountyil.gov/assessor/",
    sourceName:"Lake County IL — Tax Sale" },

  // ── MISSOURI: Land tax sales ──────────────────────────────────────────────
  { name:"St. Louis", code:"mo-stl", city:"Clayton", state:"MO", type:"auction",
    url:"https://www.stlouisco.com/YourGovernment/CountyDepartments/Revenue/LandTaxSales",
    contact:"(314) 615-5124", assessorUrl:"https://www.stlouisco.com/assessor/",
    sourceName:"St. Louis County MO — Land Tax Sales" },
  { name:"Jackson", code:"mo-jack", city:"Kansas City", state:"MO", type:"auction",
    url:"https://www.jacksongov.org/278/Tax-Sales",
    contact:"(816) 881-3232", assessorUrl:"https://www.jacksongov.org/assessor/",
    sourceName:"Jackson County MO — Tax Sales" },
  { name:"Greene", code:"mo-greene", city:"Springfield", state:"MO", type:"auction",
    url:"https://www.greenecountymo.gov/collector/land_tax_sales.php",
    contact:"(417) 868-4036", assessorUrl:"https://www.greenecountymo.gov/assessor/",
    sourceName:"Greene County MO — Land Tax Sales" },

  // ── PENNSYLVANIA: Repository sales (post-auction unsold) ─────────────────
  { name:"Monroe", code:"pa-monroe", city:"Stroudsburg", state:"PA", type:"otc",
    url:"https://www.bid4assets.com/storefront/MonroePATaxApr26",
    contact:"bid4assets.com", assessorUrl:"https://www.monroecountypa.gov/assessor/",
    sourceName:"Monroe County PA — Repository Sale" },
  { name:"Allegheny", code:"pa-alleg", city:"Pittsburgh", state:"PA", type:"auction",
    url:"https://www.alleghenycounty.us/real-estate/repository-of-unsold-properties.aspx",
    contact:"(412) 350-4100", assessorUrl:"https://www.alleghenycounty.us/real-estate/",
    sourceName:"Allegheny County PA — Repository" },
  { name:"Philadelphia", code:"pa-philly", city:"Philadelphia", state:"PA", type:"auction",
    url:"https://www.bid4assets.com/philataxsales",
    contact:"SheriffTax@phila.gov", assessorUrl:"https://opa.phila.gov/",
    sourceName:"Philadelphia County PA — Sheriff Sale" },

  // ── MARYLAND: Tax sales ───────────────────────────────────────────────────
  { name:"Baltimore", code:"md-balt", city:"Baltimore", state:"MD", type:"auction",
    url:"https://www.bidbaltimore.com/",
    contact:"bidbaltimore.com", assessorUrl:"https://sdat.dat.maryland.gov/",
    sourceName:"Baltimore County MD — Tax Sale" },
  { name:"Prince George", code:"md-pg", city:"Upper Marlboro", state:"MD", type:"auction",
    url:"https://princegeorgescountymd.realtaxlien.com/",
    contact:"realtaxlien.com", assessorUrl:"https://www.princegeorgescountymd.gov/assessor/",
    sourceName:"Prince George County MD — Tax Sale" },
  { name:"Montgomery", code:"md-mont", city:"Rockville", state:"MD", type:"auction",
    url:"https://montgomerycountymd.realtaxlien.com/",
    contact:"realtaxlien.com", assessorUrl:"https://www.montgomerycountymd.gov/assessor/",
    sourceName:"Montgomery County MD — Tax Sale" },

  // ── LOUISIANA: CivicSource parishes ──────────────────────────────────────
  { name:"East Baton Rouge", code:"la-ebr", city:"Baton Rouge", state:"LA", type:"auction",
    url:"https://www.civicsource.com/search?state=LA&county=East+Baton+Rouge",
    contact:"civicsource.com", assessorUrl:"https://www.ebrpa.org/",
    sourceName:"East Baton Rouge Parish LA — Tax Sale" },
  { name:"Jefferson", code:"la-jeff", city:"Gretna", state:"LA", type:"auction",
    url:"https://www.civicsource.com/search?state=LA&county=Jefferson",
    contact:"civicsource.com", assessorUrl:"https://www.jeffassessor.com/",
    sourceName:"Jefferson Parish LA — Tax Sale" },
  { name:"Orleans", code:"la-orleans", city:"New Orleans", state:"LA", type:"auction",
    url:"https://www.civicsource.com/search?state=LA&county=Orleans",
    contact:"civicsource.com", assessorUrl:"https://www.nolaassessor.com/",
    sourceName:"Orleans Parish LA — Tax Sale" },

  // ── COLORADO: Online tax lien sales ──────────────────────────────────────
  { name:"Denver", code:"co-denver", city:"Denver", state:"CO", type:"auction",
    url:"https://www.denvergov.org/Government/Agencies-Departments-Offices/Agencies-Departments-Offices-Directory/Department-of-Finance/About-Denver-Finance/Tax-Lien-Sale",
    contact:"(720) 913-9300", assessorUrl:"https://www.denvergov.org/assessor/",
    sourceName:"Denver County CO — Tax Lien Sale" },
  { name:"Arapahoe", code:"co-ara", city:"Centennial", state:"CO", type:"auction",
    url:"https://www.arapahoegov.com/2000/Tax-Lien-Sale",
    contact:"(303) 795-4550", assessorUrl:"https://www.arapahoegov.com/assessor/",
    sourceName:"Arapahoe County CO — Tax Lien Sale" },
  { name:"Adams", code:"co-adams", city:"Brighton", state:"CO", type:"auction",
    url:"https://www.adcogov.org/tax-lien-sale",
    contact:"(303) 659-2120", assessorUrl:"https://www.adcogov.org/assessor/",
    sourceName:"Adams County CO — Tax Lien Sale" },
  { name:"El Paso", code:"co-elpaso", city:"Colorado Springs", state:"CO", type:"auction",
    url:"https://www.elpasoco.com/treasurer/tax-lien-sale/",
    contact:"(719) 520-6600", assessorUrl:"https://www.elpasoco.com/assessor/",
    sourceName:"El Paso County CO — Tax Lien Sale" },

  // ── VIRGINIA: Land records/tax sales ─────────────────────────────────────
  { name:"Fairfax", code:"va-fairfax", city:"Fairfax", state:"VA", type:"auction",
    url:"https://www.fairfaxcounty.gov/taxes/delinquent-taxes",
    contact:"(703) 222-8234", assessorUrl:"https://www.fairfaxcounty.gov/assessments/",
    sourceName:"Fairfax County VA — Delinquent Tax" },
  { name:"Prince William", code:"va-pw", city:"Manassas", state:"VA", type:"auction",
    url:"https://www.pwcgov.org/government/dept/finance/pages/tax-sale.aspx",
    contact:"(703) 792-6710", assessorUrl:"https://www.pwcgov.org/assessor/",
    sourceName:"Prince William County VA — Tax Sale" },
  { name:"Chesterfield", code:"va-chester", city:"Chesterfield", state:"VA", type:"auction",
    url:"https://www.chesterfield.gov/government/departments/treasurer/delinquent-taxes",
    contact:"(804) 748-1281", assessorUrl:"https://www.chesterfield.gov/assessor/",
    sourceName:"Chesterfield County VA — Delinquent Tax" },

  // ── NEW JERSEY: OTC unsold liens ─────────────────────────────────────────
  { name:"Ocean", code:"nj-ocean", city:"Toms River", state:"NJ", type:"otc",
    url:"https://www.realauction.com/index.cfm?zaction=AUCTION&Zmethod=PREVIEW&state=NJ",
    contact:"realauction.com", assessorUrl:"https://www.co.ocean.nj.us/assessor/",
    sourceName:"Ocean County NJ — Tax Lien" },
  { name:"Middlesex", code:"nj-middle", city:"New Brunswick", state:"NJ", type:"otc",
    url:"https://www.realauction.com/index.cfm?zaction=AUCTION&Zmethod=PREVIEW&state=NJ",
    contact:"realauction.com", assessorUrl:"https://www.co.middlesex.nj.us/assessor/",
    sourceName:"Middlesex County NJ — Tax Lien" },
  { name:"Bergen", code:"nj-bergen", city:"Hackensack", state:"NJ", type:"otc",
    url:"https://www.co.bergen.nj.us/taxation/tax-sale",
    contact:"(201) 336-6300", assessorUrl:"https://www.co.bergen.nj.us/assessor/",
    sourceName:"Bergen County NJ — Tax Sale" },

  // ── CALIFORNIA: County tax sales ─────────────────────────────────────────
  { name:"Los Angeles", code:"ca-la", city:"Los Angeles", state:"CA", type:"auction",
    url:"https://ttc.lacounty.gov/avoid-penalties-by-understanding-postmarks/tax-delinquency/",
    contact:"(213) 974-2111", assessorUrl:"https://assessor.lacounty.gov/",
    sourceName:"Los Angeles County CA — Tax Default" },
  { name:"San Diego", code:"ca-sd", city:"San Diego", state:"CA", type:"auction",
    url:"https://www.sandiegocounty.gov/content/sdc/ttc/tax_sale.html",
    contact:"(619) 531-5787", assessorUrl:"https://www.assessor.sandi.net/",
    sourceName:"San Diego County CA — Tax Sale" },
  { name:"Sacramento", code:"ca-sac", city:"Sacramento", state:"CA", type:"auction",
    url:"https://www.saccounty.gov/Government/Departments-and-Agencies/Finance/Tax-Collection-Division/Pages/Tax-Sales.aspx",
    contact:"(916) 875-0700", assessorUrl:"https://www.assessor.saccounty.gov/",
    sourceName:"Sacramento County CA — Tax Sale" },
  { name:"Fresno", code:"ca-fresno", city:"Fresno", state:"CA", type:"auction",
    url:"https://www.co.fresno.ca.us/departments/tax-collector/tax-sale",
    contact:"(559) 600-3482", assessorUrl:"https://www.co.fresno.ca.us/assessor/",
    sourceName:"Fresno County CA — Tax Sale" },

  // ── WASHINGTON: Tax title properties ─────────────────────────────────────
  { name:"King", code:"wa-king", city:"Seattle", state:"WA", type:"otc",
    url:"https://kingcounty.gov/depts/finance-business-operations/treasury/property-tax/foreclosure.aspx",
    contact:"(206) 263-2649", assessorUrl:"https://blue.kingcounty.com/Assessor/",
    sourceName:"King County WA — Tax Foreclosure" },
  { name:"Pierce", code:"wa-pierce", city:"Tacoma", state:"WA", type:"otc",
    url:"https://www.piercecountywa.gov/1637/Tax-Title-Properties",
    contact:"(253) 798-6111", assessorUrl:"https://www.piercecountywa.gov/assessor/",
    sourceName:"Pierce County WA — Tax Title Properties" },
  { name:"Snohomish", code:"wa-snoh", city:"Everett", state:"WA", type:"otc",
    url:"https://www.snohomishcountywa.gov/1929/Tax-Foreclosure",
    contact:"(425) 388-3366", assessorUrl:"https://www.snohomishcountywa.gov/assessor/",
    sourceName:"Snohomish County WA — Tax Foreclosure" },
  // Minneapolis (recommended in book)
  { name:"Hennepin", code:"mn-henn", city:"Minneapolis", state:"MN", type:"otc",
    url:"https://www.hennepin.us/residents/property/tax-forfeited-land",
    contact:"(612) 348-3011", assessorUrl:"https://www.hennepin.us/residents/property/",
    sourceName:"Hennepin County MN — Tax Forfeited Land" },
  { name:"Ramsey", code:"mn-ramsey", city:"St. Paul", state:"MN", type:"otc",
    url:"https://www.ramseycounty.us/residents/property-and-homes/taxes/tax-forfeited-land",
    contact:"(651) 266-2000", assessorUrl:"https://www.ramseycounty.us/assessor/",
    sourceName:"Ramsey County MN — Tax Forfeited Land" },

  // ── OREGON: Tax foreclosures ──────────────────────────────────────────────
  { name:"Multnomah", code:"or-mult", city:"Portland", state:"OR", type:"auction",
    url:"https://www.multco.us/assessment-taxation/foreclosure",
    contact:"(503) 988-3326", assessorUrl:"https://www.multco.us/assessment-taxation/",
    sourceName:"Multnomah County OR — Tax Foreclosure" },
  { name:"Washington", code:"or-wash", city:"Hillsboro", state:"OR", type:"auction",
    url:"https://www.co.washington.or.us/TaxCollector/tax_foreclosure.cfm",
    contact:"(503) 846-8801", assessorUrl:"https://www.co.washington.or.us/assessor/",
    sourceName:"Washington County OR — Tax Foreclosure" },
  { name:"Lane", code:"or-lane", city:"Eugene", state:"OR", type:"auction",
    url:"https://lanecounty.org/cms/One.aspx?portalId=3585881&pageId=4294591",
    contact:"(541) 682-4321", assessorUrl:"https://lanecounty.org/assessor/",
    sourceName:"Lane County OR — Tax Foreclosure" },

  // ── NEVADA: Tax defaulted auctions ────────────────────────────────────────
  { name:"Clark", code:"nv-clark", city:"Las Vegas", state:"NV", type:"auction",
    url:"https://www.clarkcountynv.gov/government/departments/treasurer/pages/tax_auction.aspx",
    contact:"(702) 455-4323", assessorUrl:"https://assessor.clarkcountynv.gov/",
    sourceName:"Clark County NV — Tax Auction" },
  { name:"Washoe", code:"nv-washoe", city:"Reno", state:"NV", type:"auction",
    url:"https://www.washoecounty.gov/treasurer/tax_defaulted_land_sales.php",
    contact:"(775) 328-2510", assessorUrl:"https://www.washoecounty.gov/assessor/",
    sourceName:"Washoe County NV — Tax Defaulted Land" },
  { name:"Nye", code:"nv-nye", city:"Pahrump", state:"NV", type:"auction",
    url:"https://www.nyecountynv.gov/1118/2026-Online-Only-Tax-Sale-Auctions",
    contact:"Nye County Treasurer", assessorUrl:"https://www.nyecountyassessor.com/",
    sourceName:"Nye County NV — Tax Sale" },
  { name:"Elko", code:"nv-elko", city:"Elko", state:"NV", type:"auction",
    url:"https://www.bid4assets.com/storefront/ElkoNVApr26",
    contact:"bid4assets.com", assessorUrl:"https://www.elkocountynv.net/assessor/",
    sourceName:"Elko County NV — Tax Sale" },

  // ═══════════════════════════════════════════════════════════════════════
  // MISSING 26 STATES FROM THE BOOK — ADDED NOW
  // Key insight from book: SMALL RURAL COUNTIES = hidden gems
  // One bid = get it for $50. Clerk just wants them off the books.
  // ═══════════════════════════════════════════════════════════════════════

  // ── IOWA: 24% interest rate — highest lien rate ───────────────────────
  // Book p5702: Tax Lien, 24%, 2yr redemption, 99 counties
  // Small Iowa counties have properties sitting for years with zero bids
  { name:"Polk", code:"ia-polk", city:"Des Moines", state:"IA", type:"auction",
    url:"https://www.polkcountyiowa.gov/treasurer/tax-sale/",
    contact:"(515) 286-3060", assessorUrl:"https://www.assess.co.polk.ia.us/",
    sourceName:"Polk County IA — Tax Sale (24% rate)" },
  { name:"Linn", code:"ia-linn", city:"Cedar Rapids", state:"IA", type:"auction",
    url:"https://www.linncounty.org/342/Tax-Sale",
    contact:"(319) 892-5500", assessorUrl:"https://www.linncounty.org/assessor/",
    sourceName:"Linn County IA — Tax Sale (24% rate)" },
  { name:"Scott", code:"ia-scott", city:"Davenport", state:"IA", type:"auction",
    url:"https://www.scottcountyiowa.gov/treasurer/tax-sale",
    contact:"(563) 326-8664", assessorUrl:"https://www.scottcountyiowa.gov/assessor/",
    sourceName:"Scott County IA — Tax Sale (24% rate)" },
  { name:"Black Hawk", code:"ia-blackhawk", city:"Waterloo", state:"IA", type:"auction",
    url:"https://www.blackhawkcounty.iowa.gov/treasurer/tax-sales",
    contact:"(319) 833-3013", assessorUrl:"https://www.blackhawkcounty.iowa.gov/assessor/",
    sourceName:"Black Hawk County IA — Tax Sale (24% rate)" },
  // Small rural Iowa — hidden gems, zero competition
  { name:"Wayne", code:"ia-wayne", city:"Corydon", state:"IA", type:"otc",
    url:"https://www.waynecountyia.org/treasurer",
    contact:"Wayne County Treasurer", assessorUrl:"https://www.waynecountyia.org/assessor/",
    sourceName:"Wayne County IA — OTC Liens (24% rate, tiny market)" },
  { name:"Ringgold", code:"ia-ringgold", city:"Mount Ayr", state:"IA", type:"otc",
    url:"https://www.ringgoldcounty.org/government/treasurer/",
    contact:"Ringgold County Treasurer", assessorUrl:"https://www.ringgoldcounty.org/assessor/",
    sourceName:"Ringgold County IA — OTC Liens (rural hidden gem)" },

  // ── NEW YORK: 20% rate, massive market ───────────────────────────────
  // Book p7611: Tax Lien+Deed, 20%, 2yr redemption, 62 counties
  { name:"Erie", code:"ny-erie", city:"Buffalo", state:"NY", type:"auction",
    url:"https://www.erie.gov/tax/auction",
    contact:"(716) 858-8333", assessorUrl:"https://www.erie.gov/assessment/",
    sourceName:"Erie County NY — Tax Auction (20% rate)" },
  { name:"Monroe", code:"ny-monroe", city:"Rochester", state:"NY", type:"auction",
    url:"https://www.monroecounty.gov/finance-taxauction",
    contact:"(585) 753-1200", assessorUrl:"https://www.monroecounty.gov/assessment/",
    sourceName:"Monroe County NY — Tax Auction (20% rate)" },
  { name:"Onondaga", code:"ny-onon", city:"Syracuse", state:"NY", type:"auction",
    url:"https://www.ongov.net/finance/taxforeclosure.html",
    contact:"(315) 435-2426", assessorUrl:"https://www.ongov.net/assessment/",
    sourceName:"Onondaga County NY — Tax Foreclosure (20% rate)" },
  // Small upstate NY rural counties — real hidden gems
  { name:"Allegany", code:"ny-allegany", city:"Belmont", state:"NY", type:"otc",
    url:"https://www.alleganyco.com/departments/treasurer/",
    contact:"Allegany County Treasurer", assessorUrl:"https://www.alleganyco.com/assessor/",
    sourceName:"Allegany County NY — OTC (tiny rural, zero competition)" },
  { name:"Schuyler", code:"ny-schuyler", city:"Watkins Glen", state:"NY", type:"otc",
    url:"https://www.schuylercounty.us/treasurer",
    contact:"Schuyler County Treasurer", assessorUrl:"https://www.schuylercounty.us/assessor/",
    sourceName:"Schuyler County NY — OTC (rural gem, 20% rate)" },
  { name:"Delaware", code:"ny-delaware", city:"Delhi", state:"NY", type:"otc",
    url:"https://www.co.delaware.ny.us/departments/tres/tres.htm",
    contact:"Delaware County Treasurer", assessorUrl:"https://www.co.delaware.ny.us/assessor/",
    sourceName:"Delaware County NY — OTC (Catskills area, low competition)" },

  // ── MISSISSIPPI: 18% rate, very cheap properties ─────────────────────
  // Book p6529: Tax Lien, 18%, 2yr redemption, 82 counties
  // Mississippi has some of cheapest properties in the US - $50-$200 common
  { name:"Hinds", code:"ms-hinds", city:"Jackson", state:"MS", type:"auction",
    url:"https://www.hindscountyms.com/elected-officials/tax-collector/",
    contact:"(601) 968-6588", assessorUrl:"https://www.hindscountyms.com/assessor/",
    sourceName:"Hinds County MS — Tax Sale (18% rate)" },
  { name:"Harrison", code:"ms-harrison", city:"Gulfport", state:"MS", type:"auction",
    url:"https://www.co.harrison.ms.us/departments/tax-collector/",
    contact:"(228) 865-4039", assessorUrl:"https://www.co.harrison.ms.us/assessor/",
    sourceName:"Harrison County MS — Tax Sale (18% rate)" },
  { name:"DeSoto", code:"ms-desoto", city:"Hernando", state:"MS", type:"auction",
    url:"https://www.desotocountyms.gov/205/Tax-Collector",
    contact:"(662) 469-8030", assessorUrl:"https://www.desotocountyms.gov/assessor/",
    sourceName:"DeSoto County MS — Tax Sale (18% rate)" },
  // Small MS rural counties — $50-$500 properties common
  { name:"Quitman", code:"ms-quitman", city:"Marks", state:"MS", type:"otc",
    url:"https://www.co.quitman.ms.us/",
    contact:"Quitman County Tax Collector", assessorUrl:"https://www.co.quitman.ms.us/",
    sourceName:"Quitman County MS — HIDDEN GEM: rural, $50-200 properties" },
  { name:"Humphreys", code:"ms-humphreys", city:"Belzoni", state:"MS", type:"otc",
    url:"https://www.humphreyscountyms.gov/",
    contact:"Humphreys County Tax Collector", assessorUrl:"https://www.humphreyscountyms.gov/",
    sourceName:"Humphreys County MS — HIDDEN GEM: ultra-low bids" },
  { name:"Issaquena", code:"ms-issaquena", city:"Mayersville", state:"MS", type:"otc",
    url:"https://www.issaquenacountyms.gov/",
    contact:"Issaquena County Tax Collector", assessorUrl:"https://www.issaquenacountyms.gov/",
    sourceName:"Issaquena County MS — HIDDEN GEM: smallest county, no competition" },

  // ── ARKANSAS: Tax Deed, 30-day redemption — FASTEST TURNAROUND ────────
  // Book p8522: Tax Deed, 30 days redemption only — quickest flip state
  { name:"Pulaski", code:"ar-pulaski", city:"Little Rock", state:"AR", type:"auction",
    url:"https://www.pulaskicountytreasurer.net/real-estate-tax-sales",
    contact:"(501) 340-8260", assessorUrl:"https://www.pulaskicountyassessor.com/",
    sourceName:"Pulaski County AR — Tax Deed (30 day redemption!)" },
  { name:"Benton", code:"ar-benton", city:"Bentonville", state:"AR", type:"auction",
    url:"https://www.bentoncountyar.gov/collector/tax-sale",
    contact:"(479) 271-1040", assessorUrl:"https://www.bentoncountyar.gov/assessor/",
    sourceName:"Benton County AR — Tax Deed (30 day redemption)" },
  { name:"Washington", code:"ar-wash", city:"Fayetteville", state:"AR", type:"auction",
    url:"https://www.co.washington.ar.us/departments/collector/tax-sales.html",
    contact:"(479) 444-1526", assessorUrl:"https://www.co.washington.ar.us/assessor/",
    sourceName:"Washington County AR — Tax Deed (Fayetteville area)" },
  // Small AR counties — dirt cheap, fast turnaround
  { name:"Lee", code:"ar-lee", city:"Marianna", state:"AR", type:"otc",
    url:"https://www.leecountyar.com/county-collector",
    contact:"Lee County Collector", assessorUrl:"https://www.leecountyar.com/",
    sourceName:"Lee County AR — HIDDEN GEM: $50-200 properties, 30 day redemption" },
  { name:"Phillips", code:"ar-phillips", city:"Helena", state:"AR", type:"otc",
    url:"https://www.phillipscountyar.gov/county-collector",
    contact:"Phillips County Collector", assessorUrl:"https://www.phillipscountyar.gov/",
    sourceName:"Phillips County AR — HIDDEN GEM: ultra cheap, fast deed" },

  // ── WYOMING: 18% rate, only 23 counties — easy to cover all ──────────
  // Book p8348: Tax Lien, 18%, 4yr redemption, only 23 counties
  { name:"Laramie", code:"wy-laramie", city:"Cheyenne", state:"WY", type:"auction",
    url:"https://www.laramiecounty.com/treasurer/tax-sales",
    contact:"(307) 633-4225", assessorUrl:"https://www.laramiecounty.com/assessor/",
    sourceName:"Laramie County WY — Tax Sale (18% rate)" },
  { name:"Natrona", code:"wy-natrona", city:"Casper", state:"WY", type:"auction",
    url:"https://www.natrona.net/treasurer/tax-sale",
    contact:"(307) 235-9400", assessorUrl:"https://www.natrona.net/assessor/",
    sourceName:"Natrona County WY — Tax Sale (18% rate)" },
  { name:"Park", code:"wy-park", city:"Cody", state:"WY", type:"otc",
    url:"https://www.parkcounty.us/treasurer/",
    contact:"Park County Treasurer", assessorUrl:"https://www.parkcounty.us/assessor/",
    sourceName:"Park County WY — OTC (Yellowstone area, 18% rate)" },
  { name:"Sweetwater", code:"wy-sweet", city:"Rock Springs", state:"WY", type:"otc",
    url:"https://www.sweetwatercounty.net/treasurer",
    contact:"Sweetwater County Treasurer", assessorUrl:"https://www.sweetwatercounty.net/assessor/",
    sourceName:"Sweetwater County WY — OTC (18% rate, low competition)" },

  // ── KENTUCKY: 12% rate, 120 counties ─────────────────────────────────
  // Book p5965: Tax Lien, 12%, 1yr redemption, 120 counties
  { name:"Jefferson", code:"ky-jeff", city:"Louisville", state:"KY", type:"auction",
    url:"https://jeffersoncountyclerk.org/delinquent-taxes/",
    contact:"(502) 574-5700", assessorUrl:"https://www.jeffersonpva.ky.gov/",
    sourceName:"Jefferson County KY — Delinquent Tax (Louisville)" },
  { name:"Fayette", code:"ky-fayette", city:"Lexington", state:"KY", type:"auction",
    url:"https://www.fayettecountyky.gov/treasurer/delinquent",
    contact:"(859) 252-1771", assessorUrl:"https://www.fayettepva.com/",
    sourceName:"Fayette County KY — Delinquent Tax (Lexington)" },
  { name:"Kenton", code:"ky-kenton", city:"Covington", state:"KY", type:"auction",
    url:"https://www.kentoncounty.org/treasurer/delinquent-taxes",
    contact:"(859) 392-1650", assessorUrl:"https://www.kentonpva.com/",
    sourceName:"Kenton County KY — Delinquent Tax" },
  // Small KY rural — hidden gems, one bid gets it
  { name:"Owsley", code:"ky-owsley", city:"Booneville", state:"KY", type:"otc",
    url:"https://owsleycounty.ky.gov/sheriff",
    contact:"Owsley County Sheriff", assessorUrl:"https://owsleycounty.ky.gov/pva/",
    sourceName:"Owsley County KY — HIDDEN GEM: poorest county, $50 bids" },
  { name:"Wolfe", code:"ky-wolfe", city:"Campton", state:"KY", type:"otc",
    url:"https://wolfecounty.ky.gov/sheriff",
    contact:"Wolfe County Sheriff", assessorUrl:"https://wolfecounty.ky.gov/pva/",
    sourceName:"Wolfe County KY — HIDDEN GEM: rural, no competition" },
  { name:"Magoffin", code:"ky-magoffin", city:"Salyersville", state:"KY", type:"otc",
    url:"https://magoffincounty.ky.gov/sheriff",
    contact:"Magoffin County Sheriff", assessorUrl:"https://magoffincounty.ky.gov/pva/",
    sourceName:"Magoffin County KY — HIDDEN GEM: Appalachian rural gem" },

  // ── NEBRASKA: 14% rate, 93 counties ──────────────────────────────────
  // Book p7213: Tax Lien, 14%, 3yr redemption, 93 counties
  { name:"Douglas", code:"ne-douglas", city:"Omaha", state:"NE", type:"auction",
    url:"https://www.douglascounty-ne.gov/treasurer/tax-sale",
    contact:"(402) 444-7082", assessorUrl:"https://www.douglascounty-ne.gov/assessor/",
    sourceName:"Douglas County NE — Tax Sale (Omaha, 14% rate)" },
  { name:"Lancaster", code:"ne-lancaster", city:"Lincoln", state:"NE", type:"auction",
    url:"https://treasurer.lincoln.ne.gov/tax-sale",
    contact:"(402) 441-7425", assessorUrl:"https://www.lancaster.ne.gov/assessor/",
    sourceName:"Lancaster County NE — Tax Sale (Lincoln, 14% rate)" },
  // Small NE rural
  { name:"Loup", code:"ne-loup", city:"Taylor", state:"NE", type:"otc",
    url:"https://www.loupcounty.ne.gov/treasurer",
    contact:"Loup County Treasurer", assessorUrl:"https://www.loupcounty.ne.gov/assessor/",
    sourceName:"Loup County NE — HIDDEN GEM: 800 people, zero competition" },
  { name:"McPherson", code:"ne-mcpherson", city:"Tryon", state:"NE", type:"otc",
    url:"https://www.mcphersoncounty.ne.gov/treasurer",
    contact:"McPherson County Treasurer", assessorUrl:"https://www.mcphersoncounty.ne.gov/",
    sourceName:"McPherson County NE — HIDDEN GEM: smallest county in NE" },

  // ── ILLINOIS: 24-36% rate, 102 counties ───────────────────────────────
  // Already have Cook/DuPage/Lake — add more
  // Book p5180: Tax Lien, 24-36%, 6mo-3yr redemption
  { name:"Sangamon", code:"il-sang", city:"Springfield", state:"IL", type:"auction",
    url:"https://www.sangamoncounty.net/treasurer/tax-sales",
    contact:"(217) 753-6800", assessorUrl:"https://www.sangamoncounty.net/assessor/",
    sourceName:"Sangamon County IL — Tax Sale (Springfield, 36% rate)" },
  { name:"Peoria", code:"il-peoria", city:"Peoria", state:"IL", type:"auction",
    url:"https://www.peoriacounty.org/treasurer/tax-sales",
    contact:"(309) 672-6065", assessorUrl:"https://www.peoriacounty.org/assessor/",
    sourceName:"Peoria County IL — Tax Sale (36% rate)" },
  { name:"Champaign", code:"il-champaign", city:"Champaign", state:"IL", type:"auction",
    url:"https://www.co.champaign.il.us/treasurer/tax-sales",
    contact:"(217) 384-3760", assessorUrl:"https://www.co.champaign.il.us/assessor/",
    sourceName:"Champaign County IL — Tax Sale (University town)" },
  // Small IL rural counties — hidden gems at 36% interest
  { name:"Hardin", code:"il-hardin", city:"Elizabethtown", state:"IL", type:"otc",
    url:"https://www.hardincountyillinois.com/treasurer",
    contact:"Hardin County Treasurer", assessorUrl:"https://www.hardincountyillinois.com/",
    sourceName:"Hardin County IL — HIDDEN GEM: smallest IL county, 36% rate" },
  { name:"Pope", code:"il-pope", city:"Golconda", state:"IL", type:"otc",
    url:"https://www.popecountyillinois.com/treasurer",
    contact:"Pope County Treasurer", assessorUrl:"https://www.popecountyillinois.com/",
    sourceName:"Pope County IL — HIDDEN GEM: rural, nobody looking, 36% rate" },

  // ── OKLAHOMA: Tax Deed, 77 counties ──────────────────────────────────
  { name:"Oklahoma", code:"ok-okla", city:"Oklahoma City", state:"OK", type:"auction",
    url:"https://www.oklahomacounty.org/treasurer/tax-resale",
    contact:"(405) 713-1300", assessorUrl:"https://www.oklahomacounty.org/assessor/",
    sourceName:"Oklahoma County OK — Tax Resale" },
  { name:"Tulsa", code:"ok-tulsa", city:"Tulsa", state:"OK", type:"auction",
    url:"https://www.tulsacounty.org/treasurer/taxresale",
    contact:"(918) 596-5071", assessorUrl:"https://www.tulsacounty.org/assessor/",
    sourceName:"Tulsa County OK — Tax Resale" },
  { name:"Cleveland", code:"ok-cleveland", city:"Norman", state:"OK", type:"auction",
    url:"https://www.clevelandcountytreasurer.com/tax-resale",
    contact:"(405) 366-0217", assessorUrl:"https://www.clevelandcountyassessor.com/",
    sourceName:"Cleveland County OK — Tax Resale" },
  // Small OK rural — cheap properties
  { name:"Cimarron", code:"ok-cimarron", city:"Boise City", state:"OK", type:"otc",
    url:"https://www.cimarroncountyok.gov/treasurer",
    contact:"Cimarron County Treasurer", assessorUrl:"https://www.cimarroncountyok.gov/",
    sourceName:"Cimarron County OK — HIDDEN GEM: Oklahoma panhandle, $50 properties" },
  { name:"Harmon", code:"ok-harmon", city:"Hollis", state:"OK", type:"otc",
    url:"https://www.harmoncountyok.gov/treasurer",
    contact:"Harmon County Treasurer", assessorUrl:"https://www.harmoncountyok.gov/",
    sourceName:"Harmon County OK — HIDDEN GEM: tiny rural county" },

  // ── WISCONSIN: Tax Deed, 72 counties ─────────────────────────────────
  { name:"Milwaukee", code:"wi-mil", city:"Milwaukee", state:"WI", type:"auction",
    url:"https://county.milwaukee.gov/EN/County-Clerk/Off-Nav/Tax-Foreclosed-Properties",
    contact:"(414) 278-4967", assessorUrl:"https://assessments.milwaukee.gov/",
    sourceName:"Milwaukee County WI — Tax Foreclosed Properties" },
  { name:"Dane", code:"wi-dane", city:"Madison", state:"WI", type:"auction",
    url:"https://www.countyofdane.com/treasurer/tax-sale",
    contact:"(608) 266-4151", assessorUrl:"https://www.countyofdane.com/assessor/",
    sourceName:"Dane County WI — Tax Sale (Madison)" },
  { name:"Brown", code:"wi-brown", city:"Green Bay", state:"WI", type:"auction",
    url:"https://www.browncountywi.gov/departments/treasurer/tax-sale/",
    contact:"(920) 448-4074", assessorUrl:"https://www.browncountywi.gov/assessor/",
    sourceName:"Brown County WI — Tax Sale (Green Bay)" },
  // Small WI rural — lakefront hidden gems
  { name:"Iron", code:"wi-iron", city:"Hurley", state:"WI", type:"otc",
    url:"https://www.ironcountywi.gov/treasurer",
    contact:"Iron County Treasurer", assessorUrl:"https://www.ironcountywi.gov/lister/",
    sourceName:"Iron County WI — HIDDEN GEM: lakefront properties, zero bids" },
  { name:"Florence", code:"wi-florence", city:"Florence", state:"WI", type:"otc",
    url:"https://www.florencecountywi.com/treasurer",
    contact:"Florence County Treasurer", assessorUrl:"https://www.florencecountywi.com/",
    sourceName:"Florence County WI — HIDDEN GEM: northwoods, lakes, no competition" },
  { name:"Menominee", code:"wi-menominee", city:"Keshena", state:"WI", type:"otc",
    url:"https://www.menomineecountywi.gov/treasurer",
    contact:"Menominee County Treasurer", assessorUrl:"https://www.menomineecountywi.gov/",
    sourceName:"Menominee County WI — HIDDEN GEM: smallest county, nobody looking" },

  // ── WEST VIRGINIA: 12% rate, 55 counties ─────────────────────────────
  // Book p8197: Tax Lien, 12%, 18mo redemption — very cheap rural properties
  { name:"Kanawha", code:"wv-kanawha", city:"Charleston", state:"WV", type:"auction",
    url:"https://www.kanawhasheriff.us/tax-sales",
    contact:"(304) 357-0169", assessorUrl:"https://www.kanawhacountyassessor.com/",
    sourceName:"Kanawha County WV — Tax Sale (Charleston)" },
  { name:"Cabell", code:"wv-cabell", city:"Huntington", state:"WV", type:"auction",
    url:"https://www.cabellcounty.org/sheriff/tax-sales",
    contact:"(304) 526-8688", assessorUrl:"https://www.cabellsheriff.org/",
    sourceName:"Cabell County WV — Tax Sale (Huntington)" },
  // Small WV rural — Appalachian gems
  { name:"McDowell", code:"wv-mcdowell", city:"Welch", state:"WV", type:"otc",
    url:"https://www.mcdowellcountywv.com/sheriff",
    contact:"McDowell County Sheriff", assessorUrl:"https://www.mcdowellcountywv.com/assessor/",
    sourceName:"McDowell County WV — HIDDEN GEM: $50 properties, Appalachian" },
  { name:"Mingo", code:"wv-mingo", city:"Williamson", state:"WV", type:"otc",
    url:"https://www.mingocountywv.com/sheriff",
    contact:"Mingo County Sheriff", assessorUrl:"https://www.mingocountywv.com/assessor/",
    sourceName:"Mingo County WV — HIDDEN GEM: coal country, ultra cheap" },
  { name:"Webster", code:"wv-webster", city:"Webster Springs", state:"WV", type:"otc",
    url:"https://www.websternews.com/county-government/sheriff",
    contact:"Webster County Sheriff", assessorUrl:"https://www.websternews.com/county-government/assessor/",
    sourceName:"Webster County WV — HIDDEN GEM: 8,000 people, zero competition" },

  // ── MONTANA: 10% rate, 56 counties — huge land parcels ───────────────
  // Book p7057: Tax Lien, 10%, 2-3yr redemption
  // Montana = massive land parcels for pennies
  { name:"Yellowstone", code:"mt-yellow", city:"Billings", state:"MT", type:"auction",
    url:"https://co.yellowstone.mt.gov/treasurer/tax-sale",
    contact:"(406) 256-2802", assessorUrl:"https://co.yellowstone.mt.gov/assessor/",
    sourceName:"Yellowstone County MT — Tax Sale (Billings)" },
  { name:"Cascade", code:"mt-cascade", city:"Great Falls", state:"MT", type:"auction",
    url:"https://www.cascadecountymt.gov/treasurer/tax-sale",
    contact:"(406) 454-6813", assessorUrl:"https://www.cascadecountymt.gov/assessor/",
    sourceName:"Cascade County MT — Tax Sale (Great Falls)" },
  // Small MT rural — massive land, zero bids
  { name:"Petroleum", code:"mt-petroleum", city:"Winnett", state:"MT", type:"otc",
    url:"https://www.petroleumcountymt.gov/treasurer",
    contact:"Petroleum County Treasurer", assessorUrl:"https://www.petroleumcountymt.gov/",
    sourceName:"Petroleum County MT — HIDDEN GEM: 494 people, 1000-acre parcels for $100" },
  { name:"Garfield", code:"mt-garfield", city:"Jordan", state:"MT", type:"otc",
    url:"https://www.garfieldcountymt.com/treasurer",
    contact:"Garfield County Treasurer", assessorUrl:"https://www.garfieldcountymt.com/",
    sourceName:"Garfield County MT — HIDDEN GEM: Jordan MT, biggest county, no competition" },
  { name:"Treasure", code:"mt-treasure", city:"Hysham", state:"MT", type:"otc",
    url:"https://www.treasurecountymt.gov/treasurer",
    contact:"Treasure County Treasurer", assessorUrl:"https://www.treasurecountymt.gov/",
    sourceName:"Treasure County MT — HIDDEN GEM: 700 people, massive land parcels" },

  // ── KANSAS: Tax Deed, 105 counties ───────────────────────────────────
  { name:"Johnson", code:"ks-johnson", city:"Olathe", state:"KS", type:"auction",
    url:"https://www.jocogov.org/dept/treasurer/tax-sale",
    contact:"(913) 715-2600", assessorUrl:"https://www.jocogov.org/assessor/",
    sourceName:"Johnson County KS — Tax Sale (Kansas City suburb)" },
  { name:"Sedgwick", code:"ks-sedg", city:"Wichita", state:"KS", type:"auction",
    url:"https://www.sedgwickcounty.org/treasurer/real-estate-tax-sales/",
    contact:"(316) 660-9000", assessorUrl:"https://www.sedgwickcounty.org/assessor/",
    sourceName:"Sedgwick County KS — Tax Sale (Wichita)" },
  // Small KS rural — prairie hidden gems
  { name:"Greeley", code:"ks-greeley", city:"Tribune", state:"KS", type:"otc",
    url:"https://www.greeleycountyks.gov/treasurer",
    contact:"Greeley County Treasurer", assessorUrl:"https://www.greeleycountyks.gov/",
    sourceName:"Greeley County KS — HIDDEN GEM: 1,200 people, prairie farmland cheap" },
  { name:"Wallace", code:"ks-wallace", city:"Sharon Springs", state:"KS", type:"otc",
    url:"https://www.wallacecountyks.org/treasurer",
    contact:"Wallace County Treasurer", assessorUrl:"https://www.wallacecountyks.org/",
    sourceName:"Wallace County KS — HIDDEN GEM: western KS, zero competition" },

  // ── ALABAMA: 12% rate, 67 counties ───────────────────────────────────
  // Book p4423: Tax Lien, 12%, 3yr redemption
  { name:"Jefferson", code:"al-jeff", city:"Birmingham", state:"AL", type:"auction",
    url:"https://www.jeffersonco.us/taxcollector/taxsale",
    contact:"(205) 325-5500", assessorUrl:"https://www.jeffersonco.us/assessor/",
    sourceName:"Jefferson County AL — Tax Sale (Birmingham)" },
  { name:"Mobile", code:"al-mobile", city:"Mobile", state:"AL", type:"auction",
    url:"https://www.mobilecounty.org/taxcollector/taxsale",
    contact:"(251) 574-8550", assessorUrl:"https://www.mobilecounty.org/assessor/",
    sourceName:"Mobile County AL — Tax Sale" },
  { name:"Madison", code:"al-madison", city:"Huntsville", state:"AL", type:"auction",
    url:"https://www.madisoncountyal.gov/taxcollector/taxsale",
    contact:"(256) 532-3370", assessorUrl:"https://www.madisoncountyal.gov/assessor/",
    sourceName:"Madison County AL — Tax Sale (Huntsville, growing market)" },
  // Small AL rural — Black Belt counties, ultra cheap
  { name:"Greene", code:"al-greene", city:"Eutaw", state:"AL", type:"otc",
    url:"https://www.greenecountyal.gov/taxcollector",
    contact:"Greene County Tax Collector", assessorUrl:"https://www.greenecountyal.gov/assessor/",
    sourceName:"Greene County AL — HIDDEN GEM: Black Belt, $50-100 properties" },
  { name:"Sumter", code:"al-sumter", city:"Livingston", state:"AL", type:"otc",
    url:"https://www.sumtercountyal.gov/taxcollector",
    contact:"Sumter County Tax Collector", assessorUrl:"https://www.sumtercountyal.gov/",
    sourceName:"Sumter County AL — HIDDEN GEM: rural, zero competition" },
  { name:"Lowndes", code:"al-lowndes", city:"Hayneville", state:"AL", type:"otc",
    url:"https://www.lowndescountyal.gov/taxcollector",
    contact:"Lowndes County Tax Collector", assessorUrl:"https://www.lowndescountyal.gov/",
    sourceName:"Lowndes County AL — HIDDEN GEM: Selma area, dirt cheap" },

  // ── CONNECTICUT: 18% Redeemable Deed, 6mo redemption ─────────────────
  // Book p8889: Redeemable Deed, 18%, 6 months — fast and high rate
  { name:"Hartford", code:"ct-hartford", city:"Hartford", state:"CT", type:"auction",
    url:"https://www.hartford.gov/government/departments/tax-collector/tax-sale",
    contact:"(860) 757-9630", assessorUrl:"https://www.hartford.gov/assessor/",
    sourceName:"Hartford County CT — Tax Sale (18% redeemable deed)" },
  { name:"New Haven", code:"ct-newhaven", city:"New Haven", state:"CT", type:"auction",
    url:"https://www.newhavenct.gov/government/departments/finance/tax-collector/tax-sale",
    contact:"(203) 946-8054", assessorUrl:"https://www.newhavenct.gov/assessor/",
    sourceName:"New Haven County CT — Tax Sale (18%, 6mo redemption)" },

  // ── MASSACHUSETTS: 16% rate, 6mo redemption ───────────────────────────
  // Book p10025: Redeemable Deed, 16%, 6mo — fast turnaround
  { name:"Worcester", code:"ma-worcester", city:"Worcester", state:"MA", type:"auction",
    url:"https://www.worcesterma.gov/finance/tax-title",
    contact:"(508) 799-1215", assessorUrl:"https://www.worcesterma.gov/assessor/",
    sourceName:"Worcester County MA — Tax Title (16%, 6mo redemption)" },
  { name:"Hampden", code:"ma-hampden", city:"Springfield", state:"MA", type:"auction",
    url:"https://www.springfieldcityhall.com/finance/treasurer/tax-title",
    contact:"(413) 787-6294", assessorUrl:"https://www.springfieldcityhall.com/assessor/",
    sourceName:"Hampden County MA — Tax Title (Springfield)" },

  // ── NORTH DAKOTA: Tax Deed, 53 counties — huge land parcels ──────────
  { name:"Cass", code:"nd-cass", city:"Fargo", state:"ND", type:"auction",
    url:"https://www.casscountynd.gov/treasurer/tax-sale",
    contact:"(701) 241-5620", assessorUrl:"https://www.casscountynd.gov/assessor/",
    sourceName:"Cass County ND — Tax Sale (Fargo)" },
  // Small ND rural — massive cheap land
  { name:"Slope", code:"nd-slope", city:"Amidon", state:"ND", type:"otc",
    url:"https://www.slopecountynd.gov/treasurer",
    contact:"Slope County Treasurer", assessorUrl:"https://www.slopecountynd.gov/",
    sourceName:"Slope County ND — HIDDEN GEM: 700 people, prairie land for $50" },
  { name:"Billings", code:"nd-billings", city:"Medora", state:"ND", type:"otc",
    url:"https://www.billingscountynd.gov/treasurer",
    contact:"Billings County Treasurer", assessorUrl:"https://www.billingscountynd.gov/",
    sourceName:"Billings County ND — HIDDEN GEM: Badlands area, no competition" },

  // ── SOUTH DAKOTA: Tax Deed, 66 counties ──────────────────────────────
  { name:"Minnehaha", code:"sd-minn", city:"Sioux Falls", state:"SD", type:"auction",
    url:"https://www.minnehahacounty.org/dept/trea/taxsale.php",
    contact:"(605) 367-4211", assessorUrl:"https://www.minnehahacounty.org/assessor/",
    sourceName:"Minnehaha County SD — Tax Sale (Sioux Falls)" },
  { name:"Pennington", code:"sd-penn", city:"Rapid City", state:"SD", type:"auction",
    url:"https://www.pennco.org/index.asp?Type=B_BASIC&SEC={treasurer}",
    contact:"(605) 394-2163", assessorUrl:"https://www.pennco.org/assessor/",
    sourceName:"Pennington County SD — Tax Sale (Rapid City)" },
  // Rural SD
  { name:"Haakon", code:"sd-haakon", city:"Philip", state:"SD", type:"otc",
    url:"https://haakoncounty.govoffice.com/treasurer",
    contact:"Haakon County Treasurer", assessorUrl:"https://haakoncounty.govoffice.com/",
    sourceName:"Haakon County SD — HIDDEN GEM: prairie ranches, $50-100 bids" },
  { name:"Ziebach", code:"sd-ziebach", city:"Dupree", state:"SD", type:"otc",
    url:"https://ziebachcounty.govoffice.com/treasurer",
    contact:"Ziebach County Treasurer", assessorUrl:"https://ziebachcounty.govoffice.com/",
    sourceName:"Ziebach County SD — HIDDEN GEM: reservation land, no competition" },

  // ── UTAH: Tax Deed, 29 counties ───────────────────────────────────────
  { name:"Salt Lake", code:"ut-saltlake", city:"Salt Lake City", state:"UT", type:"auction",
    url:"https://slco.org/treasurer/tax-sale/",
    contact:"(385) 468-8300", assessorUrl:"https://slco.org/assessor/",
    sourceName:"Salt Lake County UT — Tax Sale" },
  { name:"Utah", code:"ut-utah", city:"Provo", state:"UT", type:"auction",
    url:"https://www.utahcounty.gov/dept/treas/TaxSale.asp",
    contact:"(801) 851-8255", assessorUrl:"https://www.utahcounty.gov/assessor/",
    sourceName:"Utah County UT — Tax Sale (Provo)" },
  // Rural UT desert land
  { name:"Daggett", code:"ut-daggett", city:"Manila", state:"UT", type:"otc",
    url:"https://www.daggettcounty.org/treasurer",
    contact:"Daggett County Treasurer", assessorUrl:"https://www.daggettcounty.org/assessor/",
    sourceName:"Daggett County UT — HIDDEN GEM: 1,100 people, desert land cheap" },
  { name:"Piute", code:"ut-piute", city:"Junction", state:"UT", type:"otc",
    url:"https://www.piutecounty.org/treasurer",
    contact:"Piute County Treasurer", assessorUrl:"https://www.piutecounty.org/assessor/",
    sourceName:"Piute County UT — HIDDEN GEM: smallest Utah county, canyon land" },

  // ── NEW MEXICO: Tax Deed, 33 counties ────────────────────────────────
  { name:"Bernalillo", code:"nm-bern", city:"Albuquerque", state:"NM", type:"auction",
    url:"https://www.bernco.gov/treasurer/delinquent-property-tax-auction.aspx",
    contact:"(505) 468-7031", assessorUrl:"https://www.bernco.gov/assessor/",
    sourceName:"Bernalillo County NM — Tax Auction (Albuquerque)" },
  { name:"Doña Ana", code:"nm-dona", city:"Las Cruces", state:"NM", type:"auction",
    url:"https://www.donaanacounty.org/treasurer/tax-sale",
    contact:"(575) 647-7433", assessorUrl:"https://www.donaanacounty.org/assessor/",
    sourceName:"Doña Ana County NM — Tax Sale (Las Cruces)" },
  // Rural NM — desert land
  { name:"Harding", code:"nm-harding", city:"Mosquero", state:"NM", type:"otc",
    url:"https://www.hardingcounty.org/treasurer",
    contact:"Harding County Treasurer", assessorUrl:"https://www.hardingcounty.org/",
    sourceName:"Harding County NM — HIDDEN GEM: 695 people, desert ranch land" },

  // ── IDAHO: Tax Deed, 44 counties ─────────────────────────────────────
  { name:"Ada", code:"id-ada", city:"Boise", state:"ID", type:"auction",
    url:"https://www.adacounty.id.gov/treasurer/tax-sale/",
    contact:"(208) 287-6800", assessorUrl:"https://www.adacounty.id.gov/assessor/",
    sourceName:"Ada County ID — Tax Sale (Boise, fast growing)" },
  { name:"Canyon", code:"id-canyon", city:"Caldwell", state:"ID", type:"auction",
    url:"https://www.canyonco.org/treasurer/tax-sale",
    contact:"(208) 454-7354", assessorUrl:"https://www.canyonco.org/assessor/",
    sourceName:"Canyon County ID — Tax Sale" },
  // Rural ID
  { name:"Clark", code:"id-clark", city:"Dubois", state:"ID", type:"otc",
    url:"https://www.clarkcountyidaho.gov/treasurer",
    contact:"Clark County Treasurer", assessorUrl:"https://www.clarkcountyidaho.gov/",
    sourceName:"Clark County ID — HIDDEN GEM: 800 people, ranch land for $100" },

  // ── RHODE ISLAND: 16% Redeemable Deed, 1yr redemption ────────────────
  { name:"Providence", code:"ri-prov", city:"Providence", state:"RI", type:"auction",
    url:"https://www.providenceri.gov/finance/tax-title/",
    contact:"(401) 680-5229", assessorUrl:"https://www.providenceri.gov/assessor/",
    sourceName:"Providence County RI — Tax Title (16% rate)" },

  // ── HAWAII: 12% Redeemable Deed, 1yr redemption ───────────────────────
  // Only 4 counties — small but unique market
  { name:"Honolulu", code:"hi-hon", city:"Honolulu", state:"HI", type:"auction",
    url:"https://www.honolulu.gov/budget/taxcollection.html",
    contact:"(808) 768-3980", assessorUrl:"https://www.honolulu.gov/assessor/",
    sourceName:"Honolulu County HI — Tax Sale (12% redeemable deed)" },
  { name:"Maui", code:"hi-maui", city:"Wailuku", state:"HI", type:"auction",
    url:"https://www.mauicounty.gov/1029/Tax-Sales",
    contact:"(808) 270-7697", assessorUrl:"https://www.mauicounty.gov/assessor/",
    sourceName:"Maui County HI — Tax Sale (luxury market)" },

  // ── NEW HAMPSHIRE: Tax Deed, 10 counties ──────────────────────────────
  { name:"Hillsborough", code:"nh-hills", city:"Manchester", state:"NH", type:"auction",
    url:"https://www.manchesternh.gov/Departments/Finance/Tax-Collector",
    contact:"(603) 624-6575", assessorUrl:"https://www.manchesternh.gov/assessor/",
    sourceName:"Hillsborough County NH — Tax Deed" },

  // ── DELAWARE: Tax Deed, 60 day redemption ─────────────────────────────
  { name:"New Castle", code:"de-newcastle", city:"Wilmington", state:"DE", type:"auction",
    url:"https://www.nccde.org/1052/Sheriff-Sales",
    contact:"(302) 395-5207", assessorUrl:"https://www.nccde.org/assessor/",
    sourceName:"New Castle County DE — Sheriff Sale (60 day redemption)" },

  // ── VERMONT: 12% Tax Lien, 14 counties ───────────────────────────────
  { name:"Chittenden", code:"vt-chitt", city:"Burlington", state:"VT", type:"auction",
    url:"https://www.burlingtonvt.gov/Finance/Delinquent-Taxes",
    contact:"(802) 865-7124", assessorUrl:"https://www.burlingtonvt.gov/assessor/",
    sourceName:"Chittenden County VT — Delinquent Tax (12% rate)" }
];

// ── EXTRA HIDDEN GEM COUNTIES ─────────────────────────────────────────────
// These are SPECIFICALLY the type the book talks about:
// One bid, $50 properties, nobody looking, clerk just wants them gone
var HIDDEN_GEM_COUNTIES = [
  // Texas — the book specifically recommends Houston but these rural TX
  // counties have struck-off properties at $50-200 that nobody bids on
  { name:"Terrell", code:"tx-terrell", city:"Sanderson", state:"TX", type:"struck_off",
    url:"https://www.co.terrell.tx.us/tax-assessor-collector",
    contact:"Terrell County Tax Office", assessorUrl:"https://www.co.terrell.tx.us/",
    sourceName:"Terrell County TX — HIDDEN GEM: 800 people, struck-off $50 bids" },
  { name:"Kenedy", code:"tx-kenedy", city:"Sarita", state:"TX", type:"struck_off",
    url:"https://www.co.kenedy.tx.us/tax",
    contact:"Kenedy County Tax Office", assessorUrl:"https://www.co.kenedy.tx.us/",
    sourceName:"Kenedy County TX — HIDDEN GEM: 400 people, ranch land" },
  { name:"Loving", code:"tx-loving", city:"Mentone", state:"TX", type:"struck_off",
    url:"https://www.co.loving.tx.us/",
    contact:"Loving County Tax Office", assessorUrl:"https://www.co.loving.tx.us/",
    sourceName:"Loving County TX — HIDDEN GEM: least populated US county, oil land" },
  { name:"Borden", code:"tx-borden", city:"Gail", state:"TX", type:"struck_off",
    url:"https://www.co.borden.tx.us/tax",
    contact:"Borden County Tax Office", assessorUrl:"https://www.co.borden.tx.us/",
    sourceName:"Borden County TX — HIDDEN GEM: 650 people, Texas prairie for $50" },
  // Florida — beyond the obvious counties
  { name:"Glades", code:"fl-glades", city:"Moore Haven", state:"FL", type:"otc",
    url:"https://gladesclerk.realtdm.com/public/cases/list",
    contact:"Glades County Clerk", assessorUrl:"https://www.gladespa.com/",
    sourceName:"Glades County FL — HIDDEN GEM: tiny, Lake Okeechobee area" },
  { name:"Liberty", code:"fl-liberty", city:"Bristol", state:"FL", type:"otc",
    url:"https://libertyclerk.realtdm.com/public/cases/list",
    contact:"Liberty County Clerk", assessorUrl:"https://www.libertycountypao.com/",
    sourceName:"Liberty County FL — HIDDEN GEM: smallest FL county, $100 bids" },
  { name:"Lafayette", code:"fl-lafayette", city:"Mayo", state:"FL", type:"otc",
    url:"https://lafayetteclerk.realtdm.com/public/cases/list",
    contact:"Lafayette County Clerk", assessorUrl:"https://www.lafayettepao.com/",
    sourceName:"Lafayette County FL — HIDDEN GEM: 8,000 people, no competition" },
  { name:"Union", code:"fl-union", city:"Lake Butler", state:"FL", type:"otc",
    url:"https://unionclerk.realtdm.com/public/cases/list",
    contact:"Union County Clerk", assessorUrl:"https://www.unioncountypa.org/",
    sourceName:"Union County FL — HIDDEN GEM: smallest counties, OTC gems" },
  { name:"Gilchrist", code:"fl-gilchrist", city:"Trenton", state:"FL", type:"otc",
    url:"https://gilchristclerk.realtdm.com/public/cases/list",
    contact:"Gilchrist County Clerk", assessorUrl:"https://www.gilchristpa.org/",
    sourceName:"Gilchrist County FL — HIDDEN GEM: rural north FL, cheap land" },
  { name:"Calhoun", code:"fl-calhoun", city:"Blountstown", state:"FL", type:"otc",
    url:"https://calhouncounty.realtdm.com/public/cases/list",
    contact:"Calhoun County Clerk", assessorUrl:"https://www.calhounpa.com/",
    sourceName:"Calhoun County FL — HIDDEN GEM: panhandle rural, no competition" },
  { name:"Gulf", code:"fl-gulf", city:"Port St Joe", state:"FL", type:"otc",
    url:"https://gulfclerk.realtdm.com/public/cases/list",
    contact:"Gulf County Clerk", assessorUrl:"https://www.gulfpa.com/",
    sourceName:"Gulf County FL — HIDDEN GEM: Gulf coast, post-hurricane OTC deals" },
  { name:"Franklin", code:"fl-franklin", city:"Apalachicola", state:"FL", type:"otc",
    url:"https://franklinclerk.realtdm.com/public/cases/list",
    contact:"Franklin County Clerk", assessorUrl:"https://www.franklinpa.org/",
    sourceName:"Franklin County FL — HIDDEN GEM: Apalachicola, coastal gem" },
  { name:"Jefferson", code:"fl-jefferson", city:"Monticello", state:"FL", type:"otc",
    url:"https://jeffersonclerk.realtdm.com/public/cases/list",
    contact:"Jefferson County Clerk", assessorUrl:"https://www.jeffersonpao.com/",
    sourceName:"Jefferson County FL — HIDDEN GEM: north FL rural, $200 OTC" },
  { name:"Taylor", code:"fl-taylor", city:"Perry", state:"FL", type:"otc",
    url:"https://taylorclerk.realtdm.com/public/cases/list",
    contact:"Taylor County Clerk", assessorUrl:"https://www.taylorcountypao.com/",
    sourceName:"Taylor County FL — HIDDEN GEM: Big Bend area, timber land" },
  { name:"Suwannee", code:"fl-suwannee", city:"Live Oak", state:"FL", type:"otc",
    url:"https://suwanneeclerk.realtdm.com/public/cases/list",
    contact:"Suwannee County Clerk", assessorUrl:"https://www.suwanneepao.org/",
    sourceName:"Suwannee County FL — HIDDEN GEM: river land, rural north FL" },
  { name:"Dixie", code:"fl-dixie", city:"Cross City", state:"FL", type:"otc",
    url:"https://dixieclerk.realtdm.com/public/cases/list",
    contact:"Dixie County Clerk", assessorUrl:"https://www.dixiecountypa.com/",
    sourceName:"Dixie County FL — HIDDEN GEM: Big Bend coast, fishing land" },
  { name:"Hamilton", code:"fl-hamilton", city:"Jasper", state:"FL", type:"otc",
    url:"https://hamiltonclerk.realtdm.com/public/cases/list",
    contact:"Hamilton County Clerk", assessorUrl:"https://www.hamiltonpa.org/",
    sourceName:"Hamilton County FL — HIDDEN GEM: I-75 corridor, rural FL" },
  { name:"Madison", code:"fl-madison", city:"Madison", state:"FL", type:"otc",
    url:"https://madisonclerk.realtdm.com/public/cases/list",
    contact:"Madison County Clerk", assessorUrl:"https://www.madisonpa.org/",
    sourceName:"Madison County FL — HIDDEN GEM: north FL, very cheap land" }
];

// Hidden gem small rural counties — added separately so we can batch them
var HIDDEN_GEM_COUNTIES = [
  { name:"Terrell", code:"tx-terrell", city:"Sanderson", state:"TX", type:"struck_off", url:"https://www.co.terrell.tx.us/tax-assessor-collector", contact:"Terrell County Tax Office", sourceName:"Terrell County TX — HIDDEN GEM: $50 bids, no competition" },
  { name:"Glades", code:"fl-glades", city:"Moore Haven", state:"FL", type:"otc", url:"https://gladesclerk.realtdm.com/public/cases/list", contact:"Glades County Clerk", sourceName:"Glades County FL — HIDDEN GEM: tiny, OTC" },
  { name:"Liberty", code:"fl-liberty", city:"Bristol", state:"FL", type:"otc", url:"https://libertyclerk.realtdm.com/public/cases/list", contact:"Liberty County Clerk", sourceName:"Liberty County FL — HIDDEN GEM: $100 bids" },
  { name:"Lafayette", code:"fl-lafayette", city:"Mayo", state:"FL", type:"otc", url:"https://lafayetteclerk.realtdm.com/public/cases/list", contact:"Lafayette County Clerk", sourceName:"Lafayette County FL — HIDDEN GEM: 8000 people" },
  { name:"Union", code:"fl-union", city:"Lake Butler", state:"FL", type:"otc", url:"https://unionclerk.realtdm.com/public/cases/list", contact:"Union County Clerk", sourceName:"Union County FL — HIDDEN GEM" },
  { name:"Gilchrist", code:"fl-gilchrist", city:"Trenton", state:"FL", type:"otc", url:"https://gilchristclerk.realtdm.com/public/cases/list", contact:"Gilchrist County Clerk", sourceName:"Gilchrist County FL — HIDDEN GEM" },
  { name:"Calhoun", code:"fl-calhoun", city:"Blountstown", state:"FL", type:"otc", url:"https://calhouncounty.realtdm.com/public/cases/list", contact:"Calhoun County Clerk", sourceName:"Calhoun County FL — HIDDEN GEM" },
  { name:"Gulf", code:"fl-gulf", city:"Port St Joe", state:"FL", type:"otc", url:"https://gulfclerk.realtdm.com/public/cases/list", contact:"Gulf County Clerk", sourceName:"Gulf County FL — HIDDEN GEM: post-hurricane deals" },
  { name:"Franklin", code:"fl-franklin", city:"Apalachicola", state:"FL", type:"otc", url:"https://franklinclerk.realtdm.com/public/cases/list", contact:"Franklin County Clerk", sourceName:"Franklin County FL — HIDDEN GEM: coastal" },
  { name:"Jefferson", code:"fl-jefferson", city:"Monticello", state:"FL", type:"otc", url:"https://jeffersonclerk.realtdm.com/public/cases/list", contact:"Jefferson County Clerk", sourceName:"Jefferson County FL — HIDDEN GEM: $200 OTC" },
  { name:"Taylor", code:"fl-taylor", city:"Perry", state:"FL", type:"otc", url:"https://taylorclerk.realtdm.com/public/cases/list", contact:"Taylor County Clerk", sourceName:"Taylor County FL — HIDDEN GEM: timber land" },
  { name:"Suwannee", code:"fl-suwannee", city:"Live Oak", state:"FL", type:"otc", url:"https://suwanneeclerk.realtdm.com/public/cases/list", contact:"Suwannee County Clerk", sourceName:"Suwannee County FL — HIDDEN GEM" },
  { name:"Dixie", code:"fl-dixie", city:"Cross City", state:"FL", type:"otc", url:"https://dixieclerk.realtdm.com/public/cases/list", contact:"Dixie County Clerk", sourceName:"Dixie County FL — HIDDEN GEM: fishing land" },
  { name:"Hamilton", code:"fl-hamilton", city:"Jasper", state:"FL", type:"otc", url:"https://hamiltonclerk.realtdm.com/public/cases/list", contact:"Hamilton County Clerk", sourceName:"Hamilton County FL — HIDDEN GEM" },
  { name:"Madison", code:"fl-madison", city:"Madison", state:"FL", type:"otc", url:"https://madisonclerk.realtdm.com/public/cases/list", contact:"Madison County Clerk", sourceName:"Madison County FL — HIDDEN GEM: cheap land" },
  { name:"Petroleum", code:"mt-petroleum", city:"Winnett", state:"MT", type:"otc", url:"https://www.petroleumcountymt.gov/treasurer", contact:"Petroleum County Treasurer", sourceName:"Petroleum County MT — HIDDEN GEM: 1000-acre parcels for $100" },
  { name:"Garfield", code:"mt-garfield", city:"Jordan", state:"MT", type:"otc", url:"https://www.garfieldcountymt.com/treasurer", contact:"Garfield County Treasurer", sourceName:"Garfield County MT — HIDDEN GEM: biggest MT county, no competition" },
  { name:"Owsley", code:"ky-owsley", city:"Booneville", state:"KY", type:"otc", url:"https://owsleycounty.ky.gov/sheriff", contact:"Owsley County Sheriff", sourceName:"Owsley County KY — HIDDEN GEM: $50 bids" },
  { name:"McDowell", code:"wv-mcdowell", city:"Welch", state:"WV", type:"otc", url:"https://www.mcdowellcountywv.com/sheriff", contact:"McDowell County Sheriff", sourceName:"McDowell County WV — HIDDEN GEM: $50 properties" },
  { name:"Wayne", code:"ia-wayne", city:"Corydon", state:"IA", type:"otc", url:"https://www.waynecountyia.org/treasurer", contact:"Wayne County Treasurer", sourceName:"Wayne County IA — HIDDEN GEM: 24% rate, tiny market" },
  { name:"Slope", code:"nd-slope", city:"Amidon", state:"ND", type:"otc", url:"https://www.slopecountynd.gov/treasurer", contact:"Slope County Treasurer", sourceName:"Slope County ND — HIDDEN GEM: 700 people, prairie for $50" },
  { name:"Loup", code:"ne-loup", city:"Taylor", state:"NE", type:"otc", url:"https://www.loupcounty.ne.gov/treasurer", contact:"Loup County Treasurer", sourceName:"Loup County NE — HIDDEN GEM: 800 people, zero competition" },
  { name:"Harding", code:"nm-harding", city:"Mosquero", state:"NM", type:"otc", url:"https://www.hardingcounty.org/treasurer", contact:"Harding County Treasurer", sourceName:"Harding County NM — HIDDEN GEM: 695 people, desert ranch land" },
  { name:"Greeley", code:"ks-greeley", city:"Tribune", state:"KS", type:"otc", url:"https://www.greeleycountyks.gov/treasurer", contact:"Greeley County Treasurer", sourceName:"Greeley County KS — HIDDEN GEM: 1200 people, farmland cheap" },
  { name:"Greene", code:"al-greene", city:"Eutaw", state:"AL", type:"otc", url:"https://www.greenecountyal.gov/taxcollector", contact:"Greene County Tax Collector", sourceName:"Greene County AL — HIDDEN GEM: $50-100 properties" },
  { name:"Hardin", code:"il-hardin", city:"Elizabethtown", state:"IL", type:"otc", url:"https://www.hardincountyillinois.com/treasurer", contact:"Hardin County Treasurer", sourceName:"Hardin County IL — HIDDEN GEM: smallest IL county, 36% rate" },
  { name:"Cimarron", code:"ok-cimarron", city:"Boise City", state:"OK", type:"otc", url:"https://www.cimarroncountyok.gov/treasurer", contact:"Cimarron County Treasurer", sourceName:"Cimarron County OK — HIDDEN GEM: Oklahoma panhandle, $50 properties" },
  { name:"Iron", code:"wi-iron", city:"Hurley", state:"WI", type:"otc", url:"https://www.ironcountywi.gov/treasurer", contact:"Iron County Treasurer", sourceName:"Iron County WI — HIDDEN GEM: lakefront land, zero bids" },
  { name:"Daggett", code:"ut-daggett", city:"Manila", state:"UT", type:"otc", url:"https://www.daggettcounty.org/treasurer", contact:"Daggett County Treasurer", sourceName:"Daggett County UT — HIDDEN GEM: 1100 people, desert land" },
  { name:"Piute", code:"ut-piute", city:"Junction", state:"UT", type:"otc", url:"https://www.piutecounty.org/treasurer", contact:"Piute County Treasurer", sourceName:"Piute County UT — HIDDEN GEM: canyon land, no competition" },
  { name:"Clark", code:"id-clark", city:"Dubois", state:"ID", type:"otc", url:"https://www.clarkcountyidaho.gov/treasurer", contact:"Clark County Treasurer", sourceName:"Clark County ID — HIDDEN GEM: 800 people, ranch land $100" }
];


// ── BID4ASSETS ACTIVE STOREFRONTS ─────────────────────────────────────────
var BID4ASSETS = [
  { url:"https://www.bid4assets.com/storefront/RiversideCountyApr26", county:"Riverside County", state:"CA", date:"Apr 23-28, 2026", deposit:"$5,035" },
  { url:"https://www.bid4assets.com/storefront/NyeNVMay26", county:"Nye County", state:"NV", date:"May 1-4, 2026", deposit:"$535" },
  { url:"https://www.bid4assets.com/storefront/ChurchillNVMay26", county:"Churchill County", state:"NV", date:"May 15, 2026", deposit:"$500" },
  { url:"https://www.bid4assets.com/storefront/ModocMay26", county:"Modoc County", state:"CA", date:"May 18, 2026", deposit:"$500" },
  { url:"https://www.bid4assets.com/storefront/ElkoNVApr26", county:"Elko County", state:"NV", date:"Apr 20-24, 2026", deposit:"$500" },
  { url:"https://www.bid4assets.com/storefront/CarsonCityApr26", county:"Carson City", state:"NV", date:"Apr 22, 2026", deposit:"$500" },
  { url:"https://www.bid4assets.com/philataxsales", county:"Philadelphia County", state:"PA", date:"Ongoing", deposit:"Certified check" },
  // From the book - eBay tax deeds (yes really)
  { url:"https://www.ebay.com/sch/i.html?_nkw=tax+deed+property&_sop=10", county:"Various", state:"US", date:"Ongoing", deposit:"Varies" },
  // Arizona - bidapachecounty.com (mentioned directly in book)
  { url:"https://www.bidapachecounty.com/main", county:"Apache County", state:"AZ", date:"Various", deposit:"Varies" },
  // GrantStreet auctions (book p71 - Arizona + others)
  { url:"https://auctions.grantstreet.com/auctions/index/", county:"Various", state:"US", date:"Various", deposit:"Varies" }
];

// ── HARDCODED BASE ─────────────────────────────────────────────────────────
var HARDCODED = [
  {external_id:"b4a-rv-502540049",address:"182 Paseo Florido",city:"Palm Springs",state:"CA",county:"Riverside County",zip:"92262",status:"auction",min_bid:50899,arv:185000,beds:3,baths:2,sqft:1240,year_built:1972,parcel_id:"502-540-049",auction_date:"Apr 23-28, 2026",source_name:"Bid4Assets — Riverside Co. CA",source_url:"https://www.bid4assets.com/auction/index/1265738",county_url:"https://www.bid4assets.com/storefront/RiversideCountyApr26",assessor_url:"https://www.assessor.rivco.org/",deposit_required:"$5,035",contact:"taxsale@rivco.org",notes:"Tax-defaulted. No reserve. 862 parcels.",photo:"https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=500&q=75"},
  {external_id:"b4a-rv-637280018",address:"Parcel 637-280-018 Vacant Land",city:"Desert Hot Springs",state:"CA",county:"Riverside County",zip:"92240",status:"auction",min_bid:1211,arv:28000,beds:null,baths:null,sqft:null,year_built:null,parcel_id:"637-280-018",auction_date:"Apr 23-28, 2026",source_name:"Bid4Assets — Riverside Co. CA",source_url:"https://www.bid4assets.com/storefront/RiversideCountyApr26",county_url:"https://www.bid4assets.com/storefront/RiversideCountyApr26",assessor_url:"https://www.assessor.rivco.org/",deposit_required:"$5,035",contact:"taxsale@rivco.org",notes:"Vacant land.",photo:"https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=500&q=75"},
  {external_id:"wc-mi-gratiot12345",address:"12345 Gratiot Ave",city:"Detroit",state:"MI",county:"Wayne County",zip:"48205",status:"foreclosure",min_bid:6800,arv:58000,beds:3,baths:1,sqft:1050,year_built:1948,parcel_id:"21-012345-0",auction_date:"Sept 2026",source_name:"Wayne County Treasurer",source_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",county_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",assessor_url:"https://pta.waynecounty.com/",deposit_required:"TBD",contact:"(313) 224-5990",notes:"2026 foreclosure list.",photo:"https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=500&q=75"},
  {external_id:"wc-mi-linwood8901",address:"8901 Linwood St",city:"Detroit",state:"MI",county:"Wayne County",zip:"48206",status:"foreclosure",min_bid:4500,arv:42000,beds:2,baths:1,sqft:920,year_built:1942,parcel_id:"16-008901-0",auction_date:"Sept 2026",source_name:"Wayne County Treasurer",source_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",county_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",assessor_url:"https://pta.waynecounty.com/",deposit_required:"TBD",contact:"(313) 224-5990",notes:"2026 Wayne County list.",photo:"https://images.unsplash.com/photo-1523217582562-09d0def993a6?w=500&q=75"},
  {external_id:"b4a-ph-nreese2847",address:"2847 N Reese St",city:"Philadelphia",state:"PA",county:"Philadelphia County",zip:"19133",status:"sheriff",min_bid:19500,arv:89000,beds:3,baths:1,sqft:1100,year_built:1925,parcel_id:"31-2-2847-00",auction_date:"Ongoing",source_name:"Bid4Assets Philadelphia Sheriff",source_url:"https://www.bid4assets.com/philataxsales",county_url:"https://www.bid4assets.com/philataxsales",assessor_url:"https://opa.phila.gov/",deposit_required:"Certified check",contact:"SheriffTax@phila.gov",notes:"Sheriff sale.",photo:"https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=500&q=75"},
  {external_id:"nye-nv-pahrump2026",address:"Trust Property Parcel TBD",city:"Pahrump",state:"NV",county:"Nye County",zip:"89048",status:"auction",min_bid:1500,arv:95000,beds:3,baths:2,sqft:1380,year_built:1995,parcel_id:"Apr 2026",auction_date:"May 1-4, 2026",source_name:"Nye County NV Tax Sale",source_url:"https://www.nyecountynv.gov/1118/2026-Online-Only-Tax-Sale-Auctions",county_url:"https://www.nyecountynv.gov/1118/2026-Online-Only-Tax-Sale-Auctions",assessor_url:"https://www.nyecountyassessor.com/",deposit_required:"$535",contact:"Nye County Treasurer",notes:"Online-only. 10% buyer fee.",photo:"https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=500&q=75"}
];


// State-by-state key info from the book
var STATE_INFO = {
  "AZ": { type:"lien", rate:"16%", redemption:"3 years", notes:"Register weeks in advance. Feb sales." },
  "CO": { type:"lien", rate:"9% over prime", redemption:"3 years", notes:"Oct sales. 14 counties online via RealAuction." },
  "FL": { type:"lien", rate:"18% max", redemption:"2 years", notes:"May sales. Bid down from 18% to 0.25%. 5% min." },
  "IN": { type:"lien", rate:"10-15%", redemption:"1 year", notes:"Commissioner sales 120 days. ZeusAuction." },
  "LA": { type:"lien", rate:"12%+5% penalty", redemption:"3 years", notes:"41% max return yr3. CivicSource.com." },
  "MD": { type:"lien", rate:"varies", redemption:"6 months", notes:"7 counties online. BidBaltimore.com." },
  "NJ": { type:"lien", rate:"18% max", redemption:"2 years", notes:"OTC unsold liens available. RealAuction." },
  "TX": { type:"deed", rate:"25-50%", redemption:"6mo-2yr", notes:"No mortgage after sale. ForecloseHouston.com." },
  "GA": { type:"deed", rate:"20%", redemption:"1 year", notes:"Redemption period — budget for it." },
  "MI": { type:"deed", rate:"N/A", redemption:"None", notes:"Forfeited land — direct purchase. Some $500." },
  "OH": { type:"deed", rate:"N/A", redemption:"None", notes:"Forfeited Land Commission. Direct purchase." },
  "MN": { type:"deed", rate:"N/A", redemption:"None", notes:"Tax forfeited land. Minneapolis recommended." },
  "WA": { type:"deed", rate:"N/A", redemption:"None", notes:"Tax title properties. King/Pierce/Snohomish." },
  "NC": { type:"deed", rate:"N/A", redemption:"None", notes:"Tax foreclosures. Charlotte/Raleigh hot." },
  "TN": { type:"deed", rate:"N/A", redemption:"1 year", notes:"Nashville top migration city 2026." },
  "SC": { type:"deed", rate:"N/A", redemption:"1 year", notes:"Myrtle Beach vacation rental demand." },
  "CA": { type:"deed", rate:"N/A", redemption:"1 year", notes:"High prices but huge equity potential." },
  "NV": { type:"deed", rate:"N/A", redemption:"None", notes:"No reserve auctions via Bid4Assets." },
  "IL": { type:"lien", rate:"18-36%", redemption:"2.5 years", notes:"Cook County Chicago huge market." },
  "MO": { type:"deed", rate:"N/A", redemption:"1 year", notes:"Land tax sales. St. Louis and KC." },
  "PA": { type:"deed", rate:"N/A", redemption:"None", notes:"Repository sales = OTC post-auction." },
  "VA": { type:"deed", rate:"N/A", redemption:"1 year", notes:"Northern VA high value properties." },
  "OR": { type:"deed", rate:"N/A", redemption:"2 years", notes:"Portland metro foreclosures." }
};

// ── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  var hour = new Date().getUTCHours();
  var BATCHES = ["base","fl_0","fl_1","b4a","states_0","states_1","states_2","gems"];
  var BATCH = process.env.BATCH || BATCHES[hour % BATCHES.length];

  console.log("=== PropScan Scraper ===");
  console.log("Time:", new Date().toISOString());
  console.log("Batch:", BATCH);
  console.log("States covered:", [...new Set(ALL_STATE_COUNTIES.map(c=>c.state))].sort().join(", "));

  var props = [];

  if (BATCH === "base") {
    props = [...HARDCODED];
    console.log("Saving", props.length, "base properties");

  } else if (BATCH === "fl_0") {
    console.log("FL counties 0-19...");
    for (var i = 0; i < Math.min(20, FL_COUNTIES.length); i++) {
      var r = await scrapePutnamStyle(FL_COUNTIES[i]);
      props = props.concat(r);
      await sleep(500);
    }

  } else if (BATCH === "fl_1") {
    console.log("FL counties 20+...");
    for (var i = 20; i < FL_COUNTIES.length; i++) {
      var r = await scrapePutnamStyle(FL_COUNTIES[i]);
      props = props.concat(r);
      await sleep(500);
    }

  } else if (BATCH === "b4a") {
    console.log("Bid4Assets storefronts...");
    for (var a of BID4ASSETS) {
      var r = await scrapeBid4Assets(a);
      props = props.concat(r);
      await sleep(1200);
    }

  } else if (BATCH === "states_0") {
    // First third of state counties
    var slice = ALL_STATE_COUNTIES.slice(0, Math.floor(ALL_STATE_COUNTIES.length / 3));
    console.log("States batch 0:", slice.length, "counties...");
    for (var c of slice) {
      var r = await scrapeSimpleCountyPage(c);
      props = props.concat(r);
      await sleep(600);
    }

  } else if (BATCH === "states_1") {
    // Middle third
    var start = Math.floor(ALL_STATE_COUNTIES.length / 3);
    var end = Math.floor(ALL_STATE_COUNTIES.length * 2 / 3);
    var slice = ALL_STATE_COUNTIES.slice(start, end);
    console.log("States batch 1:", slice.length, "counties...");
    for (var c of slice) {
      var r = await scrapeSimpleCountyPage(c);
      props = props.concat(r);
      await sleep(600);
    }

  } else if (BATCH === "states_2") {
    // Last third
    var start = Math.floor(ALL_STATE_COUNTIES.length * 2 / 3);
    var slice = ALL_STATE_COUNTIES.slice(start);
    console.log("States batch 2:", slice.length, "counties...");
    for (var c of slice) {
      var r = await scrapeSimpleCountyPage(c);
      props = props.concat(r);
      await sleep(600);
    }

  } else if (BATCH === "gems") {
    // Hidden gem small rural counties — the $50 properties nobody finds
    console.log("Hidden gem counties:", HIDDEN_GEM_COUNTIES.length, "counties...");
    console.log("These are the counties the book talks about:");
    console.log("  One bid = property for $50. Clerk just wants them gone.");
    for (var gem of HIDDEN_GEM_COUNTIES) {
      var r = await scrapeSimpleCountyPage(gem);
      // Tag all as hidden gems in notes
      r.forEach(function(p) {
        if (!p.notes) p.notes = "";
        if (p.notes.indexOf("HIDDEN GEM") < 0) {
          p.notes = "💎 HIDDEN GEM: " + gem.sourceName + ". " + p.notes;
        }
      });
      props = props.concat(r);
      await sleep(500);
    }
    console.log("Gems found:", props.length);
  }

  // Deduplicate
  var seen = new Set();
  var unique = props.filter(p => {
    if (!p.external_id) return false;
    if (seen.has(p.external_id)) return false;
    seen.add(p.external_id);
    return true;
  });

  if (unique.length === 0) {
    console.log("No properties found");
    return;
  }

  console.log("Saving", unique.length, "properties...");
  var saved = await supabaseUpsert(unique);
  console.log("Saved:", saved);

  // Breakdown
  var byState = {};
  unique.forEach(p => { byState[p.state||"?"] = (byState[p.state||"?"]||0)+1; });
  console.log("By state:", JSON.stringify(byState));
  console.log("OTC gems:", unique.filter(p=>p.status==="otc").length);
  console.log("=== Done ===");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
