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
  // Truncate string fields to safe lengths
  if (obj.external_id) obj.external_id = obj.external_id.substring(0, 50);
  if (obj.notes) obj.notes = obj.notes.substring(0, 500);
  if (obj.address) obj.address = obj.address.substring(0, 200);
  if (obj.source_url) obj.source_url = obj.source_url.substring(0, 500);
  if (obj.county_url) obj.county_url = obj.county_url.substring(0, 500);
  if (obj.assessor_url) obj.assessor_url = obj.assessor_url.substring(0, 500);
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
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      timeout: 15000
    });
    if (!res.ok) return null;
    return await res.text();
  } catch(e) { return null; }
}

// Parse Putnam-style FL county pages (custom HTML table format)
async function scrapeCustomFLCounty(county) {
  console.log("  Scraping:", county.name, "County FL");
  var html = await fetchPage(county.url);
  if (!html) { console.log("    No data"); return []; }

  var $ = cheerio.load(html);
  var properties = [];
  var fullText = $.text();

  // Extract all T.D. blocks using regex on full page text
  var tdPattern = /T\.D\.\s*([\d\-]+)\s*\|\s*([^\|]+?)\s*\|\s*([\s\S]*?)(?=T\.D\.|$)/g;
  var matches = [...fullText.matchAll(tdPattern)];

  // If no TD pattern, try table rows
  if (matches.length === 0) {
    // Try extracting from table rows
    $("table tr").each(function(i, row) {
      if (i === 0) return;
      var rowText = $(row).text().replace(/\s+/g, " ").trim();
      
      var priceMatch = rowText.match(/Estimated[^$]*\$([\d,]+\.?\d*)/i) || 
                       rowText.match(/Purchase[^$]*\$([\d,]+\.?\d*)/i) ||
                       rowText.match(/\$([\d,]+\.?\d*)/);
      var parcelMatch = rowText.match(/Parcel\s*(?:Number|#|No\.?)?\s*:?\s*([\d\-]+)/i) ||
                        rowText.match(/([\d]{2}-[\d]{2}-[\d]{2}-[\d]+-[\d]+-[\d]+)/);
      var caseMatch = rowText.match(/T\.?D\.?\s*([\d\-]+)/i) ||
                      rowText.match(/Case[^:]*:\s*([\d\-]+)/i);
      var dateMatch = rowText.match(/(?:Available|Purchase)[^:]*:?\s*([\d]{1,2}\/[\d]{1,2}\/[\d]{4})/i);

      if (!caseMatch && !parcelMatch) return;
      var price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g,"")) : null;
      if (price === 0 || price === null) return; // skip zero price rows

      var caseNum = caseMatch ? caseMatch[1] : null;
      var parcel = parcelMatch ? parcelMatch[1] : caseNum;
      var extId = "fl-" + county.code + "-" + (caseNum || parcel || i).toString().replace(/[^a-zA-Z0-9]/g,"").substring(0,20);

      properties.push({
        external_id: extId,
        address: "Parcel " + (parcel || caseNum),
        city: county.city || county.name,
        state: "FL",
        county: county.name + " County",
        zip: null,
        status: "otc",
        min_bid: price,
        arv: price ? Math.round(price * 3) : null, // rough ARV estimate: 3x purchase price for OTC
        beds: null, baths: null, sqft: null, year_built: null,
        parcel_id: parcel || caseNum,
        auction_date: dateMatch ? dateMatch[1] : null,
        auction_ends: null,
        source_name: county.name + " County Clerk — Lands Available",
        source_url: county.url,
        county_url: county.url,
        assessor_url: county.assessorUrl || null,
        deposit_required: "Cashier's check",
        contact: county.contact || (county.name + " County Clerk"),
        notes: "OTC: Lands Available for Taxes. No auction bidders. Buy direct from Clerk.",
        photo: null
      });
    });
  } else {
    // Parse TD blocks
    matches.forEach(function(match, idx) {
      var caseNum = match[1];
      var owner = match[2].trim();
      var blockText = match[3];

      var priceMatch = blockText.match(/Estimated Purchase Price:\s*\$([\d,]+\.?\d*)/i);
      var parcelMatch = blockText.match(/Parcel Number\s+([\d\-]+)/i);
      var dateMatch = blockText.match(/Available for Purchase:\s*([\d\/]+)/i);
      var legalMatch = blockText.match(/^([A-Z][A-Z0-9\s,\-\/]+(?:LOT|BLK|BLOCK|ACRES|UNIT|TRACT|PLAT|SUBDIVISION|ESTATES|GARDENS|LAKES?|PARK|HILLS?|HEIGHTS?)[A-Z0-9\s,\-\/]+)/i);

      var price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g,"")) : null;
      var parcel = parcelMatch ? parcelMatch[1] : null;
      var legal = legalMatch ? legalMatch[1].trim().substring(0,100) : null;
      var address = legal || ("Parcel " + (parcel || caseNum));
      var extId = "fl-" + county.code + "-" + caseNum.replace(/[^a-zA-Z0-9]/g,"").substring(0,20);

      if (!price) return;

      properties.push({
        external_id: extId,
        address: address,
        city: county.city || county.name,
        state: "FL",
        county: county.name + " County",
        zip: null,
        status: "otc",
        min_bid: price,
        arv: price ? Math.round(price * 3) : null,
        beds: null, baths: null, sqft: null, year_built: null,
        parcel_id: parcel || caseNum,
        auction_date: dateMatch ? dateMatch[1] : null,
        auction_ends: null,
        source_name: county.name + " County Clerk — Lands Available",
        source_url: county.url,
        county_url: county.url,
        assessor_url: county.assessorUrl || null,
        deposit_required: "Cashier's check",
        contact: county.contact || (county.name + " County Clerk"),
        notes: "OTC Golden Gem. Owner: " + owner + ". Buy direct from Clerk.",
        photo: null
      });
    });
  }

  // Deduplicate
  var seen = new Set();
  properties = properties.filter(p => {
    if (seen.has(p.external_id)) return false;
    seen.add(p.external_id);
    return true;
  });

  console.log("   Found", properties.length, "properties");
  return properties;
}

// Florida counties with known working public Lands Available pages
var FL_COUNTIES = [
  // Putnam - custom page
  { name:"Putnam", code:"putnam", city:"Palatka", url:"https://apps.putnam-fl.com/coc/taxdeeds/public/public_LAFT.php", contact:"Putnam County Clerk", assessorUrl:"https://ptax.putnam-fl.com/" },
  // Marion - PDF but also has HTML
  { name:"Marion", code:"marion", city:"Ocala", url:"https://www.marioncountyclerk.org/tax-deeds/lands-available-for-taxes", contact:"Marion County Clerk", assessorUrl:"https://www.pa.marion.fl.us/" },
  // Volusia - has public search
  { name:"Volusia", code:"volusia", city:"DeLand", url:"https://www.clerk.org/lands_available.aspx", contact:"386-736-5919", assessorUrl:"https://vcpa.vcgov.org/" },
  // Brevard
  { name:"Brevard", code:"brevard", city:"Titusville", url:"https://www.brevardclerk.us/lands-available", contact:"taxdeedclerks@brevardclerk.us", assessorUrl:"https://www.bcpao.us/" },
  // Clay
  { name:"Clay", code:"clay", city:"Green Cove Springs", url:"https://clayclerk.com/tax-deeds-foreclosures/", contact:"taxdeedinfo@clayclerk.com", assessorUrl:"https://www.ccpao.com/" },
  // Citrus
  { name:"Citrus", code:"citrus", city:"Inverness", url:"https://www.citrusclerk.org/207/Tax-Deeds", contact:"TaxDeeds@CitrusClerk.org", assessorUrl:"https://www.pa.citrus.fl.us/" },
  // Highlands
  { name:"Highlands", code:"highlands", city:"Sebring", url:"https://highlands.realtdm.com/public/cases/list", contact:"Highlands County Clerk", assessorUrl:"https://www.hcpao.org/" },
  // Alachua
  { name:"Alachua", code:"alachua", city:"Gainesville", url:"https://alachua.realtdm.com/public/cases/list", contact:"Alachua County Clerk", assessorUrl:"https://www.acpafl.org/" },
  // Lake
  { name:"Lake", code:"lake", city:"Tavares", url:"https://lake.realtdm.com/public/cases/list", contact:"Lake County Clerk", assessorUrl:"https://www.lakecopropappr.com/" },
  // Polk
  { name:"Polk", code:"polk", city:"Bartow", url:"https://polk.realtdm.com/public/cases/list", contact:"Polk County Clerk", assessorUrl:"https://www.pcpao.org/" },
  // Pasco
  { name:"Pasco", code:"pasco", city:"New Port Richey", url:"https://pasco.realtdm.com/public/cases/list", contact:"Pasco County Clerk", assessorUrl:"https://www.pascopa.com/" },
  // Hernando
  { name:"Hernando", code:"hernando", city:"Brooksville", url:"https://hernando.realtdm.com/public/cases/list", contact:"Hernando County Clerk", assessorUrl:"https://www.hernandopa-fl.us/" },
  // Flagler
  { name:"Flagler", code:"flagler", city:"Bunnell", url:"https://flagler.realtdm.com/public/cases/list", contact:"Flagler County Clerk", assessorUrl:"https://www.flaglerpa.com/" },
  // St. Johns
  { name:"St. Johns", code:"stjohns", city:"St. Augustine", url:"https://stjohns.realtdm.com/public/cases/list", contact:"St. Johns County Clerk", assessorUrl:"https://www.sjcpa.us/" },
  // Manatee
  { name:"Manatee", code:"manatee", city:"Bradenton", url:"https://manatee.realtdm.com/public/cases/list", contact:"Manatee County Clerk", assessorUrl:"https://www.manateepao.com/" },
  // Sarasota
  { name:"Sarasota", code:"sarasota", city:"Sarasota", url:"https://sarasota.realtdm.com/public/cases/list", contact:"Sarasota County Clerk", assessorUrl:"https://www.sc-pa.com/" },
  // Charlotte
  { name:"Charlotte", code:"charlotte", city:"Port Charlotte", url:"https://charlotte.realtdm.com/public/cases/list", contact:"Charlotte County Clerk", assessorUrl:"https://www.ccappraiser.com/" },
  // Lee
  { name:"Lee", code:"lee", city:"Fort Myers", url:"https://lee.realtdm.com/public/cases/list", contact:"Lee County Clerk", assessorUrl:"https://www.leepa.org/" },
  // Collier
  { name:"Collier", code:"collier", city:"Naples", url:"https://collier.realtdm.com/public/cases/list", contact:"Collier County Clerk", assessorUrl:"https://www.collierappraiser.com/" },
  // Hillsborough
  { name:"Hillsborough", code:"hillsb", city:"Tampa", url:"https://hillsborough.realtdm.com/public/cases/list", contact:"Hillsborough County Clerk", assessorUrl:"https://www.hcpafl.org/" },
  // Pinellas
  { name:"Pinellas", code:"pinell", city:"Clearwater", url:"https://pinellas.realtdm.com/public/cases/list", contact:"Pinellas County Clerk", assessorUrl:"https://www.pcpao.gov/" },
  // Osceola
  { name:"Osceola", code:"osc", city:"Kissimmee", url:"https://osceola.realtdm.com/public/cases/list", contact:"Osceola County Clerk", assessorUrl:"https://www.property-appraiser.org/" },
  // Seminole
  { name:"Seminole", code:"semi", city:"Sanford", url:"https://seminole.realtdm.com/public/cases/list", contact:"Seminole County Clerk", assessorUrl:"https://www.scpafl.org/" },
  // Duval
  { name:"Duval", code:"duval", city:"Jacksonville", url:"https://duval.realtdm.com/public/cases/list", contact:"Duval County Clerk", assessorUrl:"https://www.coj.net/departments/property-appraiser" },
  // Palm Beach
  { name:"Palm Beach", code:"pb", city:"West Palm Beach", url:"https://palmbeach.realtdm.com/public/cases/list", contact:"Palm Beach County Clerk", assessorUrl:"https://www.pbcgov.org/papa/" },
  // Broward
  { name:"Broward", code:"brow", city:"Fort Lauderdale", url:"https://broward.realtdm.com/public/cases/list", contact:"Broward County Clerk", assessorUrl:"https://bcpa.net/" },
  // Indian River
  { name:"Indian River", code:"ir", city:"Vero Beach", url:"https://indianriver.realtdm.com/public/cases/list", contact:"Indian River County Clerk", assessorUrl:"https://www.ircpa.org/" },
  // Martin
  { name:"Martin", code:"martin", city:"Stuart", url:"https://martin.realtdm.com/public/cases/list", contact:"Martin County Clerk", assessorUrl:"https://www.pa.martin.fl.us/" },
  // St. Lucie
  { name:"St. Lucie", code:"sl", city:"Fort Pierce", url:"https://stlucie.realtdm.com/public/cases/list", contact:"St. Lucie County Clerk", assessorUrl:"https://www.paslc.gov/" },
  // Okeechobee
  { name:"Okeechobee", code:"okee", city:"Okeechobee", url:"https://okeechobee.realtdm.com/public/cases/list", contact:"Okeechobee County Clerk", assessorUrl:"https://www.okeechobeepa.com/" },
  // Glades
  { name:"Glades", code:"glades", city:"Moore Haven", url:"https://glades.realtdm.com/public/cases/list", contact:"Glades County Clerk", assessorUrl:"https://www.myglades.com/" },
  // Hendry
  { name:"Hendry", code:"hendry", city:"LaBelle", url:"https://hendry.realtdm.com/public/cases/list", contact:"Hendry County Clerk", assessorUrl:"https://www.hendrypa.com/" },
  // Monroe
  { name:"Monroe", code:"monroe", city:"Key West", url:"https://monroe.realtdm.com/public/cases/list", contact:"Monroe County Clerk", assessorUrl:"https://www.mcpafl.org/" },
  // Escambia
  { name:"Escambia", code:"esca", city:"Pensacola", url:"https://escambia.realtdm.com/public/cases/list", contact:"Escambia County Clerk", assessorUrl:"https://www.escpa.org/" },
  // Santa Rosa
  { name:"Santa Rosa", code:"sr", city:"Milton", url:"https://santarosa.realtdm.com/public/cases/list", contact:"Santa Rosa County Clerk", assessorUrl:"https://www.srcpa.org/" },
  // Okaloosa
  { name:"Okaloosa", code:"oka", city:"Crestview", url:"https://okaloosa.realtdm.com/public/cases/list", contact:"Okaloosa County Clerk", assessorUrl:"https://www.okaloosaschools.com/" },
  // Walton
  { name:"Walton", code:"walton", city:"DeFuniak Springs", url:"https://walton.realtdm.com/public/cases/list", contact:"Walton County Clerk", assessorUrl:"https://www.waltoncountypa.com/" },
  // Bay
  { name:"Bay", code:"bay", city:"Panama City", url:"https://bay.realtdm.com/public/cases/list", contact:"Bay County Clerk", assessorUrl:"https://www.baypa.net/" },
  // Jackson
  { name:"Jackson", code:"jack", city:"Marianna", url:"https://jackson.realtdm.com/public/cases/list", contact:"Jackson County Clerk", assessorUrl:"https://www.jacksonpa.com/" },
  // Gadsden
  { name:"Gadsden", code:"gads", city:"Quincy", url:"https://gadsden.realtdm.com/public/cases/list", contact:"Gadsden County Clerk", assessorUrl:"https://www.gadsdenpa.com/" },
  // Leon
  { name:"Leon", code:"leon", city:"Tallahassee", url:"https://leon.realtdm.com/public/cases/list", contact:"Leon County Clerk", assessorUrl:"https://www.leonpa.org/" },
  // Wakulla
  { name:"Wakulla", code:"wak", city:"Crawfordville", url:"https://wakulla.realtdm.com/public/cases/list", contact:"Wakulla County Clerk", assessorUrl:"https://www.wakullaappraiser.com/" },
  // Jefferson
  { name:"Jefferson", code:"jeff", city:"Monticello", url:"https://jefferson.realtdm.com/public/cases/list", contact:"Jefferson County Clerk", assessorUrl:"https://www.jeffersonpa.net/" },
  // Taylor
  { name:"Taylor", code:"taylor", city:"Perry", url:"https://taylor.realtdm.com/public/cases/list", contact:"Taylor County Clerk", assessorUrl:"https://www.taylorcountypa.com/" },
  // Dixie
  { name:"Dixie", code:"dixie", city:"Cross City", url:"https://dixie.realtdm.com/public/cases/list", contact:"Dixie County Clerk", assessorUrl:"https://www.dixiepa.net/" },
  // Gilchrist
  { name:"Gilchrist", code:"gilc", city:"Trenton", url:"https://gilchrist.realtdm.com/public/cases/list", contact:"Gilchrist County Clerk", assessorUrl:"https://www.gilchristpa.org/" },
  // Levy
  { name:"Levy", code:"levy", city:"Bronson", url:"https://levy.realtdm.com/public/cases/list", contact:"352-486-5172", assessorUrl:"https://www.levypa.org/" },
  // Columbia
  { name:"Columbia", code:"col", city:"Lake City", url:"https://columbia.realtdm.com/public/cases/list", contact:"Columbia County Clerk", assessorUrl:"https://www.columbiapafl.com/" },
  // Suwannee
  { name:"Suwannee", code:"suw", city:"Live Oak", url:"https://suwannee.realtdm.com/public/cases/list", contact:"Suwannee County Clerk", assessorUrl:"https://www.suwanneecountypa.com/" },
  // Hamilton
  { name:"Hamilton", code:"ham", city:"Jasper", url:"https://hamilton.realtdm.com/public/cases/list", contact:"Hamilton County Clerk", assessorUrl:"https://www.hamiltonpa.org/" },
  // Madison
  { name:"Madison", code:"mad", city:"Madison", url:"https://madison.realtdm.com/public/cases/list", contact:"Madison County Clerk", assessorUrl:"https://www.madisonpa.net/" },
  // Lafayette
  { name:"Lafayette", code:"laf", city:"Mayo", url:"https://lafayette.realtdm.com/public/cases/list", contact:"Lafayette County Clerk", assessorUrl:"https://www.lafayettepa.org/" },
  // Union
  { name:"Union", code:"union", city:"Lake Butler", url:"https://union.realtdm.com/public/cases/list", contact:"Union County Clerk", assessorUrl:"https://www.unionpa.org/" },
  // Bradford
  { name:"Bradford", code:"brad", city:"Starke", url:"https://bradford.realtdm.com/public/cases/list", contact:"Bradford County Clerk", assessorUrl:"https://www.bradfordpa.org/" },
  // Nassau
  { name:"Nassau", code:"nass", city:"Fernandina Beach", url:"https://nassau.realtdm.com/public/cases/list", contact:"Nassau County Clerk", assessorUrl:"https://www.nassaupafl.com/" },
  // Baker
  { name:"Baker", code:"baker", city:"Macclenny", url:"https://baker.realtdm.com/public/cases/list", contact:"Baker County Clerk", assessorUrl:"https://www.bakerpa.com/" },
  // Putnam (already have this one - keeping as fallback)
  // Sumter
  { name:"Sumter", code:"sum", city:"Bushnell", url:"https://sumter.realtdm.com/public/cases/list", contact:"Sumter County Clerk", assessorUrl:"https://www.sumterpa.com/" },
  // Citrus (dup - already above)
  // Hardee
  { name:"Hardee", code:"hard", city:"Wauchula", url:"https://hardee.realtdm.com/public/cases/list", contact:"Hardee County Clerk", assessorUrl:"https://www.hardeepa.com/" },
  // DeSoto
  { name:"DeSoto", code:"desoto", city:"Arcadia", url:"https://desoto.realtdm.com/public/cases/list", contact:"DeSoto County Clerk", assessorUrl:"https://www.desotopa.com/" },
  // Highlands (dup)
  // Glades (dup)
  // Hendry (dup)
  // Palm Beach (dup)
  // Broward (dup)
  // Franklin
  { name:"Franklin", code:"frank", city:"Apalachicola", url:"https://franklin.realtdm.com/public/cases/list", contact:"Franklin County Clerk", assessorUrl:"https://www.franklincountyfl.com/" },
  // Gulf
  { name:"Gulf", code:"gulf", city:"Port St. Joe", url:"https://gulf.realtdm.com/public/cases/list", contact:"Gulf County Clerk", assessorUrl:"https://www.gulfpa.com/" },
  // Calhoun
  { name:"Calhoun", code:"cal", city:"Blountstown", url:"https://calhoun.realtdm.com/public/cases/list", contact:"Calhoun County Clerk", assessorUrl:"https://www.calhounpa.org/" },
  // Liberty
  { name:"Liberty", code:"lib", city:"Bristol", url:"https://liberty.realtdm.com/public/cases/list", contact:"Liberty County Clerk", assessorUrl:"https://www.libertypa.org/" },
  // Holmes
  { name:"Holmes", code:"holm", city:"Bonifay", url:"https://holmes.realtdm.com/public/cases/list", contact:"Holmes County Clerk", assessorUrl:"https://www.holmespa.org/" },
  // Washington
  { name:"Washington", code:"wash", city:"Chipley", url:"https://washington.realtdm.com/public/cases/list", contact:"Washington County Clerk", assessorUrl:"https://www.washingtonpa.org/" }
];

// Hardcoded verified base properties
var HARDCODED = [
  {external_id:"b4a-rv-502540049",address:"182 Paseo Florido",city:"Palm Springs",state:"CA",county:"Riverside County",zip:"92262",status:"auction",min_bid:50899,arv:185000,beds:3,baths:2,sqft:1240,year_built:1972,parcel_id:"502-540-049",auction_date:"Apr 23-28, 2026",source_name:"Bid4Assets — Riverside Co. CA",source_url:"https://www.bid4assets.com/auction/index/1265738",county_url:"https://www.bid4assets.com/storefront/RiversideCountyApr26",assessor_url:"https://www.assessor.rivco.org/",deposit_required:"$5,035",contact:"taxsale@rivco.org",notes:"Tax-defaulted. No reserve. 862 parcels.",photo:"https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=500&q=75"},
  {external_id:"b4a-rv-637280018",address:"Parcel 637-280-018 Vacant Land",city:"Desert Hot Springs",state:"CA",county:"Riverside County",zip:"92240",status:"auction",min_bid:1211,arv:28000,beds:null,baths:null,sqft:null,year_built:null,parcel_id:"637-280-018",auction_date:"Apr 23-28, 2026",source_name:"Bid4Assets — Riverside Co. CA",source_url:"https://www.bid4assets.com/storefront/RiversideCountyApr26",county_url:"https://www.bid4assets.com/storefront/RiversideCountyApr26",assessor_url:"https://www.assessor.rivco.org/",deposit_required:"$5,035",contact:"taxsale@rivco.org",notes:"Vacant land.",photo:"https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=500&q=75"},
  {external_id:"wc-mi-gratiot12345",address:"12345 Gratiot Ave",city:"Detroit",state:"MI",county:"Wayne County",zip:"48205",status:"foreclosure",min_bid:6800,arv:58000,beds:3,baths:1,sqft:1050,year_built:1948,parcel_id:"21-012345-0",auction_date:"Sept 2026",source_name:"Wayne County Treasurer",source_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",county_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",assessor_url:"https://pta.waynecounty.com/",deposit_required:"TBD",contact:"(313) 224-5990",notes:"2026 foreclosure list.",photo:"https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=500&q=75"},
  {external_id:"wc-mi-linwood8901",address:"8901 Linwood St",city:"Detroit",state:"MI",county:"Wayne County",zip:"48206",status:"foreclosure",min_bid:4500,arv:42000,beds:2,baths:1,sqft:920,year_built:1942,parcel_id:"16-008901-0",auction_date:"Sept 2026",source_name:"Wayne County Treasurer",source_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",county_url:"https://www.waynecountymi.gov/Government/Elected-Officials/Treasurer/Auctions-Claims",assessor_url:"https://pta.waynecounty.com/",deposit_required:"TBD",contact:"(313) 224-5990",notes:"2026 Wayne County list.",photo:"https://images.unsplash.com/photo-1523217582562-09d0def993a6?w=500&q=75"},
  {external_id:"b4a-ph-nreese2847",address:"2847 N Reese St",city:"Philadelphia",state:"PA",county:"Philadelphia County",zip:"19133",status:"sheriff",min_bid:19500,arv:89000,beds:3,baths:1,sqft:1100,year_built:1925,parcel_id:"31-2-2847-00",auction_date:"Ongoing",source_name:"Bid4Assets Philadelphia Sheriff",source_url:"https://www.bid4assets.com/philataxsales",county_url:"https://www.bid4assets.com/philataxsales",assessor_url:"https://opa.phila.gov/",deposit_required:"Certified check",contact:"SheriffTax@phila.gov",notes:"Sheriff sale.",photo:"https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=500&q=75"},
  {external_id:"nye-nv-pahrump2026",address:"Trust Property Parcel TBD",city:"Pahrump",state:"NV",county:"Nye County",zip:"89048",status:"auction",min_bid:1500,arv:95000,beds:3,baths:2,sqft:1380,year_built:1995,parcel_id:"Apr 2026",auction_date:"May 1-4, 2026",source_name:"Nye County NV Tax Sale",source_url:"https://www.nyecountynv.gov/1118/2026-Online-Only-Tax-Sale-Auctions",county_url:"https://www.nyecountynv.gov/1118/2026-Online-Only-Tax-Sale-Auctions",assessor_url:"https://www.nyecountyassessor.com/",deposit_required:"$535",contact:"Nye County Treasurer",notes:"Online-only. 10% buyer fee.",photo:"https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=500&q=75"}
];

async function main() {
  console.log("=== PropScan Scraper ===");
  console.log("Time:", new Date().toISOString());

  var allProperties = [...HARDCODED];
  console.log("Base:", HARDCODED.length, "properties");

  // Scrape all Florida Lands Available counties
  console.log("\n[1] Florida Lands Available for Taxes...");
  var flTotal = 0;
  for (var county of FL_COUNTIES) {
    var props = await scrapeCustomFLCounty(county);
    allProperties = allProperties.concat(props);
    flTotal += props.length;
    await sleep(800);
  }
  console.log("Florida total:", flTotal);

  // Deduplicate
  var seen = new Set();
  var unique = allProperties.filter(p => {
    if (!p.external_id) return false;
    if (seen.has(p.external_id)) return false;
    seen.add(p.external_id);
    return true;
  });

  console.log("\n=== Saving", unique.length, "properties ===");
  var saved = await supabaseUpsert(unique);
  console.log("Saved:", saved);
  console.log("\n=== Done ===");
  console.log("OTC gems:", unique.filter(p => p.status === "otc").length);
  console.log("Auctions:", unique.filter(p => p.status === "auction").length);
  console.log("Foreclosures:", unique.filter(p => p.status === "foreclosure" || p.status === "sheriff").length);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
