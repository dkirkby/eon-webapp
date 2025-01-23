console.log('starting script');

// polyfills for safari and firefox, which don't support "import ... with ..." as of Jan 2025
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import/with#browser_compatibility
async function importJSON(url) {
    return fetch(url).then(res => res.json());
}
async function importCSS(url) {
    return fetch(url).then(res => res.text()).then(cssText => {
        const stylesheet = new CSSStyleSheet();
        stylesheet.replaceSync(cssText);
        return stylesheet;
    });
}

const EON = new URL("https://data.desi.lbl.gov/desi/engineering/focalplane/endofnight/");
const DATA = new URL("https://data.desi.lbl.gov/desi/spectro/data/");

const ASSETS = new URL(EON);
ASSETS.pathname += 'assets.json';

let assets;
try {
    //import assets from "https://data.desi.lbl.gov/desi/engineering/focalplane/endofnight/assets.json" with { type: 'json' };
    assets = await importJSON(ASSETS);

    const allNights = Object.keys(assets.nights);
    console.log(`Loaded ${allNights.length} nights from rundate ${assets.rundate}`);
    const renderInfo = new Map(allNights.map(night => {
        const {expids, EON} = assets.nights[night];
        let classes;
        if(expids.length == 0) classes = "nodata";
        else classes = EON ? "available" : "missing";
        const disabled = classes != "available";
        return [night, { disabled, classes }];
    }));
}
catch(error) {
    console.log('Unable to load assets.json');
    console.log(error);
}

import AirDatepicker from 'https://cdn.jsdelivr.net/npm/air-datepicker@3.5.3/+esm';

//import sheet from 'https://cdn.jsdelivr.net/npm/air-datepicker@3.5.3/air-datepicker.min.css' with { type: 'css' };
const sheet = await importCSS('https://cdn.jsdelivr.net/npm/air-datepicker@3.5.3/air-datepicker.min.css');
document.adoptedStyleSheets = [ sheet ];

// TODO: check if these are the latest versions
import {decompressSync,strFromU8} from "https://cdn.skypack.dev/fflate?min";
import {load as yamlLoad} from "https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.mjs";
import {csvParse,dsvFormat,autoType} from "https://cdn.skypack.dev/d3-dsv@3";
import * as d3Array from "https://cdn.skypack.dev/d3-array@3";

import {Runtime, Inspector} from "https://cdn.jsdelivr.net/npm/@observablehq/runtime@5/dist/runtime.js";
import define from "https://api.observablehq.com/@dkirkby/focal-plane-inspector-2@4029.js?v=4";
var runtime;

const httpErrorStatusCodes = new Map([
    [400, "Bad Request"],
    [401, "Unauthorized"],
    [403, "Forbidden"],
    [404, "Not Found"],
    [405, "Method Not Allowed"],
    [408, "Request Timeout"],
    [429, "Too Many Requests"],
    [500, "Internal Server Error"],
    [502, "Bad Gateway"],
    [503, "Service Unavailable"]
  ]);
// Helper function for building request(url) promise chains
function checkResponseStatus(response) {
    const s = response.status;
    let msg = null;
    if(httpErrorStatusCodes.has(s)) msg = `${response.url}: ${httpErrorStatusCodes.get(s)}`;
    else if(s >= 400 && s < 600) msg = `${response.url} Error ${s}`;
    if(msg) throw new Error(msg);
    return response;
}
// Helper function for trying fetch on a list of URLs
async function fetchFirstSuccessful(urls, name, callback, options = {}) {
    for (const _url of urls) {
        const url = new URL(_url);
        url.pathname += name;
        console.log(`fetchFirstSuccessful: trying ${url}`);
        if(callback) callback(url);
        try {
            const response = await fetch(url, options);
            if (response.ok) return response; // Return the first successful response
        } catch (error) {
            const msg = httpErrorStatusCodes.get(response.status) || `Error ${response.status}`;
            console.error(`fetchFirstSuccessful: failed for ${url}: ${msg}`);
        }
    }
    throw new Error("None of the URLs were successful.");
}
// Helper function to load an image
async function loadImage(urls, name, callback, elem) {
    console.log("loadImage", urls, name);
    return fetchFirstSuccessful(urls, name, callback)
        .then(response => response.blob())
        .then(blob => URL.createObjectURL(blob))
        .then(url => {
            elem.src = url;
            return elem;
        })
        .catch(err => {
            console.log("loadImage", err);
            throw new Error(`loadImage: failed with ${err.toString}`);
        });
}

async function parseECSV(source) {
    // The ECSV format is defined at https://github.com/astropy/astropy-APEs/blob/main/APE6.rst
    return source.text()
    .then(txt=>{
        const lines=txt.split("\n");
        let comments=lines.filter(line=>line.startsWith("# ")).map(line=>line.slice(2));
        if(!comments[0].trim().startsWith("%ECSV")) throw new Error("Missing %ECSV header");
        const version=Number(comments[0].trim().slice(6));
        comments=comments.slice(1).join("\n");
        const body=lines.filter(line=>line[0]!="#").join("\n");
        return {version,comments,body};
    })
    .then(({version,comments,body})=>{
        const header=yamlLoad(comments);
        if(!header?.datatype) throw new Error("Header is missing required datatype");
        const delimiter=header?.delimiter ?? " ";
        const data=dsvFormat(delimiter).parse(body, autoType);
        return Object.assign({version,data},header);
    });
}

// Helpers to remove any existing child nodes and create a single span child node
function errorMsg(parent, text, { timestamp } = {}) {
    return createSpan(parent, text, { timestamp, className: "errorText"} );
}
function warnMsg(parent, text, { timestamp } = {}) {
    return createSpan(parent, text, { timestamp, className: "warnText"} );
}
function infoMsg(parent, text, { timestamp } = {}) {
    return createSpan(parent, text, { timestamp });
}
function createSpan(parent, text, { className, timestamp }={}) {
    const span = document.createElement("span");
    if(className) span.classList.add(className);
    span.innerText = text;
    parent.replaceChildren(span);
}

function localTime(dateString) {
    const local = new Date(new Date(dateString).getTime() - 7*3600*1000);
    const zpad = n => {
        let s = n.toFixed(0);
        if(s.length == 1) s = "0" + s;
        return s;
    }
    const hours = local.getUTCHours().toString();
    const mins = zpad(local.getUTCHours());
    const secs = zpad(local.getUTCSeconds());
    return `${hours}:${mins}:${secs} local`;
}

// Locale import does not work, see https://github.com/t1m0n/air-datepicker/issues/440
// import { localeEn } from 'https://cdn.jsdelivr.net/npm/air-datepicker@3.5.3/locale/en.js';
// Instead we create this by hand here.
const datepickerLocaleEn = {
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    daysMin: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    today: 'Today',
    clear: 'Clear',
    dateFormat: 'yyyyMMdd',
    timeFormat: 'hh:mm aa',
    firstDay: 0
};

var theNight;

const nightPattern = new RegExp('^20[0-9]{6}$');
const expidPattern = new RegExp('^[0-9]{8}$');

// Check that expid is a valid exposure id in the range [10000,99999999] and return
// a zero-padded 8-digit string.
function validExpid(expid) {
    expid = expid.toString();
    if(expid.match(expidPattern)) return expid;
    expid = +expid;
    if(isNaN(expid) || (expid < 10000) || (expid > 99999999)) {
        console.log(`validExpid: not a number between [10000,99999999] "${expid}"`);
        return null;
    }
    if(expid < 100000) return "000" + expid;
    if(expid < 1000000) return "00" + expid;
    if(expid < 10000000) return "0" + expid;
    return expid;
}

function dateToNight(D) {
    const [year,month,day] = [D.getFullYear(), D.getMonth()+1, D.getDate()];
    let night = "" + year;
    if(month < 10) night += "0";
    night += month;
    if(day < 10) night += "0";
    night += day;
    return night;
}
function nightToDate(night) {
    if(!night.match(nightPattern)) {
        console.error(`nightToDate: invalid night "${night}"`);
        return null;
    }
    const year = night.substring(0, 4), month = night.substring(4, 6) - 1, day = night.substring(6, 8);
    return new Date(year, month, day);
}

var resetUpdates;

function setNight(night, {eon_expid, local=false}={}) {
    console.log('setNight', night, eon_expid, local);
    const summary = document.getElementById("summary");
    if(!night.match(nightPattern)) {
        console.log(`Invalid night: "${night}".`);
        errorMsg(summary, `Invalid night: "${night}". Pick another night.`);
        return;
    }
    if(!(eon_expid == null)) {
        eon_expid = validExpid(eon_expid);
        if(eon_expid == null) {
            errorMsg(summary, `Invalid eon_expid in URL query string.`);
            return;
        }
    }
    theNight = night;
    if(resetUpdates != null) resetUpdates();
    document.getElementById("title").innerText = `${theNight} Focalplane End-of-Night Summary`;
    const dataURL = new URL(DATA);
    dataURL.pathname += night.toString() + "/";
    document.getElementById("dataURL").innerHTML = `<span>${theNight} raw data at <a href="${dataURL.href}">${dataURL.href}</a></span>`;
    if(!local) {
        // Look up this night in the assets list
        if(!(night in assets.nights) || !assets.nights[night]?.EON) {
            console.log(`No EON data for ${night}.`);
            errorMsg(summary, `${theNight} is not listed in the assets`);
            // Try to read this night anyway
        }
        else {
            const nexp = assets.nights[theNight].expids.length;
            infoMsg(summary, `${theNight} has ${nexp} positioning exposures`);
        }
    }
    // Load the assets for this night.
    const promises = [];
    const nightURLs = [ ];
    if(local) {
        // Look in ./local/YYYYMMDD/ relative to the location of index.html
        const nightURL = new URL("./local/", window.location.origin + window.location.pathname);
        nightURL.pathname += theNight;
        nightURLs.push(nightURL);
    }
    else if(!(eon_expid == null)) {
        const nightURL = new URL(dataURL);
        nightURL.pathname += eon_expid;
        nightURLs.push(nightURL);
    }
    else {
        // Use EON/NIGHT if available, since this can be generated by hand in case of problems
        const nightURL1 = new URL(EON);
        nightURL1.pathname += theNight;
        nightURLs.push(nightURL1);
        let assets_EON = assets.nights?.[theNight]?.EON;
        console.log(`${theNight} assets EON is ${assets_EON}`);
        assets_EON = validExpid(assets_EON);
        if(!(assets_EON == null)) {
            // Use auto-generated analysis if available
            const nightURL2 = new URL(dataURL);
            nightURL2.pathname += assets_EON;
            nightURLs.push(nightURL2);
        }
    }
    const nightURLsMsg = `Looking for ${theNight} assets in [ ` + nightURLs.map(url => url.href).join(" , ") + " ]";
    console.log(`setNight: ${nightURLsMsg}`);
    infoMsg(document.getElementById("srcURL"), nightURLsMsg);
    const loadStart = Date.now();
    const loadElapsed = () => {
        const elapsed = Date.now() - loadStart;
        return elapsed.toFixed() + "ms";
    }
    // moves compressed CSV file
    const load_moves = document.getElementById("load-moves");
    promises.push(
        fetchFirstSuccessful(nightURLs, `/moves-${night}.csv.gz`, url => warnMsg(load_moves, `Loading moves from ${url}...`))
        .then(checkResponseStatus)
        .then(response => response.blob())
        .then(blob => blob.arrayBuffer())
        .then(buf => decompressSync(new Uint8Array(buf)))
        .then(U8 => csvParse(strFromU8(U8), autoType))
        .then(data => {
            data = d3Array.group(data, device=>device.location);
            if(runtime) runtime.redefine("theMoves", data);
            infoMsg(load_moves, `Loaded moves in ${loadElapsed()}`);
        })
        .catch(err => {
            errorMsg(load_moves, `Failed to load moves: ${err.toString()}`);
        })
    );
    // hardware tables compressed CSV file
    const load_hwtables = document.getElementById("load-hwtables");
    promises.push(
        fetchFirstSuccessful(nightURLs, `/hwtables-${night}.csv.gz`, url => warnMsg(load_hwtables, `Loading hwtables from ${url}...`))
        .then(checkResponseStatus)
        .then(response => response.blob())
        .then(blob => blob.arrayBuffer())
        .then(buf => decompressSync(new Uint8Array(buf)))
        .then(U8 => csvParse(strFromU8(U8), autoType))
        .then(data => {
            data = d3Array.group(data, d => d.posid, d => d.exposure_id, d => d.exp_iter);
            if(runtime) runtime.redefine("theHWTables", data);
            infoMsg(load_hwtables, `Loaded hwtables in ${loadElapsed()}`);
        })
        .catch(err => {
            errorMsg(load_hwtables, `Failed to load hwtables: ${err.toString()}`);
        })
    );
    // summary ECSV file
    const load_summary = document.getElementById("load-summary");
    const meta_info = document.getElementById("meta-info");
    const setup_info = document.getElementById("setup-info"), park_info = document.getElementById("park-info"),
        index_info = document.getElementById("index-info"), snapshot_info = document.getElementById("snapshot-info");
    warnMsg(setup_info, "Looking up metadata...");
    infoMsg(park_info, "");
    infoMsg(index_info, "");
    infoMsg(snapshot_info, "");
    promises.push(
        fetchFirstSuccessful(nightURLs, `/fp-${night}.ecsv`, url => warnMsg(load_summary, `Loading summary from ${url}...`))
        .then(checkResponseStatus)
        .then(response => parseECSV(response))
        .then(({data,datatype,meta}) => {
            const index=d3Array.index(data, device=>device.LOCATION);
            if(runtime) runtime.redefine("theSummary", { data,datatype,meta,index });
            infoMsg(load_summary, `Loaded summary in ${loadElapsed()}`);
            infoMsg(setup_info, `FP setup is expid ${meta.setup_id} at ${localTime(meta.setup_time)}`);
            infoMsg(park_info, `End-night park is expid ${meta.park_id} at ${localTime(meta.park_time)}`);
            infoMsg(index_info, `Using index table ${meta.index_name}`);
            infoMsg(snapshot_info, `Using offline snapshot ${meta.snapshot}`);
        })
        .catch(err => {
            errorMsg(load_summary, `Failed to load summary: ${err.toString()}`);
        })
    );
    // calibration updates
    const load_calib = document.getElementById("load-calib");
    promises.push(
        fetchFirstSuccessful(nightURLs, `/calib-${night}.csv`, url => warnMsg(load_calib, `Loading calibration updates from ${url}...`))
        .then(checkResponseStatus)
        .then(response => response.text())
        .then(text => csvParse(text, autoType))
        .then(data => {
            data = d3Array.group(data, d => d.location);
            if(runtime) runtime.redefine("theCalib", data);
            infoMsg(load_calib, `Loaded calibration update in ${loadElapsed()}`);
        })
        .catch(err => {
            errorMsg(load_calib, `Failed to load calibration updates: ${err.toString()}`);
        })
    );
    // front-illuminated image
    const frontImage = new Image();
    const load_front = document.getElementById("load-front");
    promises.push(
        loadImage(nightURLs, `/fvc-front-${night}.jpg`, url => warnMsg(load_front, `Loading front image from ${url}...`), frontImage)
        .then(img => { if(runtime) runtime.redefine("theFront", img); })
        .then(() => infoMsg(load_front, `Loaded front image in ${loadElapsed()}`))
        .catch(err => {
            console.log(`Failed to load ${theNight} front-illuminated image`);
            console.log(err);
            errorMsg(load_front, `Failed to load front-illuminated image: : ${err.toString()}`);
        })
    );
    // back-illuminated image
    const backImage = new Image();
    const load_back = document.getElementById("load-back");
    promises.push(
        loadImage(nightURLs, `/fvc-back-${night}.jpg`, url => warnMsg(load_back, `Loading back image from ${url}...`), backImage)
        .then(img => { if(runtime) runtime.redefine("theBack", img); })
        .then(() => infoMsg(load_back, `Loaded back image in ${loadElapsed()}`))
        .catch(err => {
            console.log(`Failed to load ${theNight} back-illuminated image`);
            console.log(err);
            errorMsg(load_back, `Failed to load back-illuminated image: : ${err.toString()}`);
        })
    );
    // Wait for all assets to finish loading.
    Promise.all(promises)
    .then(() => {
        console.log("All assets loaded successfully.");
    })
    .catch((error) => {
        console.log('Uncaught error while loading assets:', error);
    });
}

async function main() {

    const now = new Date();
    if(assets) {
        const status = document.getElementById("status");
        const elapsedDays = (now - new Date(assets.rundate)) / (24 * 3600 * 1000);
        const statusText = `Endofnight script ran at ${assets.rundate} (${elapsedDays.toFixed(1)} days ago)`;
        if(elapsedDays > 1.5) {
            warnMsg(status, statusText);
        }
        else {
            infoMsg(status, statusText);
        }
    }
    const pagenow = document.getElementById("pagenow");
    infoMsg(pagenow, `Loading ${window.location.href} at ${now.toISOString()}`);

    // Parse any URL parameters.
    const query = new URLSearchParams(window.location.search);

    // Set the initial night from the query or, by default, today's date.
    if(query.has("night")) setNight(query.get("night"), { eon_expid:query.get("eon_expid"), local:query.has("local") });
    else setNight(allNights[allNights.length-1]);

    // Convert the initial night to a date to highlight in the date picker.
    let initialDate;
    try {
        const year = theNight.substring(0, 4), month = theNight.substring(4, 6) - 1, day = theNight.substring(6, 8);
        // Create corresponding date in localtime
        initialDate = new Date(year, month, day);
    }
    catch(e) {
        console.log("unable to set initialDate");
    }

    if(!query.has("local")) {
        console.log("creating date-picker...");
        const datepicker = new AirDatepicker('#datepicker', {
            locale: datepickerLocaleEn,
            dateFormat: 'yyyy/MM/dd', // also set in the locale
            minDate: nightToDate(allNights[0]),
            maxDate: nightToDate(allNights[allNights.length - 1]),
            multipleDates: false,
            selectedDates: initialDate,
            onRenderCell: ({date, cellType}) => {
                const night = dateToNight(date);
                return (cellType == "day") ? renderInfo.get(night) : { };
                // datepicker does not disable in the month/year views correctly as of v3.5.3
                // see https://github.com/t1m0n/air-datepicker/issues/637
            },
            onSelect: ({date, formattedDate, datepicker}) => {
                const night = dateToNight(date);
                console.log("date-picker select", date, night, formattedDate, datepicker.selectedDates);
                setNight(night);
            },
        });
    }

    console.log("initializing observable components...");
    runtime = new Runtime().module(define, name => {
        if(name === "viewof displayOptions") return new Inspector(document.querySelector("#displayOptions"));
        if(name === "canvas") return new Inspector(document.querySelector("#canvas"));
        if(name === "viewof target") return new Inspector(document.querySelector("#target"));
        if(name === "targetInfo") return new Inspector(document.querySelector("#targetInfo"));
        if(name === "viewof expertForm") return new Inspector(document.querySelector("#expertForm"));
        if(name === "expertCommands") return new Inspector(document.querySelector("#expertCommands"));
        if(name === "viewof targetMoves") return new Inspector(document.querySelector("#targetMoves"));
        if(name === "targetPlots") return new Inspector(document.querySelector("#targetPlots"));
        if(name === "viewof selectedMove") return new Inspector(document.querySelector("#selectedMove"));
        if(name === "resetButton") return new Inspector(document.querySelector("#resetButton"));
        if(name === "nextButton") return new Inspector(document.querySelector("#nextButton"));
        if(name === "viewof hwModel") return new Inspector(document.querySelector("#hwModel"));
        if(name === "viewof animationFrame") return new Inspector(document.querySelector("#animationFrame"));
        if(name === "anglesPlot") return new Inspector(document.querySelector("#anglesPlot"));
        if(name === "hwDisplay") return new Inspector(document.querySelector("#hwDisplay"));
        if(name === "updatesTable") return new Inspector(document.querySelector("#updatesTable"));
        if(name === "inputStyle") return new Inspector(document.querySelector("#inputStyle"));
        return [
            "live","frontSync","backSync","summarySync","targeting","tracking","targetDev","dbLinks","setTarget",
            "XYplot","Pplot","Tplot","dPplot","dTplot","dXYplot","targetMovesFiltered","flaggedRobots",
            "thisNight","angleUpdates","consoleUpdates","calibrationUpdates","scaleUpdates","theUpdates",
            "hwData","hwAngles","hwAnimationData","expIdIter","goalsSet","playConnected",
        ].includes(name);
    });
    runtime.redefine("theMoves", null);
    runtime.redefine("theHWTables", null);
    runtime.redefine("theSummary", null);
    runtime.redefine("theCalib", null);
    runtime.redefine("theFront", null);
    runtime.redefine("theBack", null);
    const setTarget = await runtime.value("setTarget");
    resetUpdates = await runtime.value("resetUpdates");
    const thisNight = await runtime.value("thisNight");

    const obsday = document.getElementById("obsday");
    infoMsg(obsday, `Current OBSDAY is ${thisNight}.`);

    if(query.has("select")) {
        // Set the target device from the query string
        const sel = query.get("select");
        console.log(`Selecting "${sel}"...`);
        setTarget(sel);
    }
}

if(document.readyState === "loading") {
    console.log('waiting for DOMContentLoaded before running main');
    window.addEventListener('DOMContentLoaded', main);
}
else {
    console.log('DOM content already loaded - running main now');
    main();
}

// viewof displayOptions = TypeError: Cannot read properties of null (reading 'meta')