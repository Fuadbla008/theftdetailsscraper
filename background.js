let isRunning = false;
let isPaused = false;
let queue = [];
let results = [];
let activeFetch = 0;
let MAX_CONCURRENT = 15;
let mapping = {};

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

function logMessage(msg) {
  const logText = `[${new Date().toLocaleTimeString()}] ${msg}`;
  chrome.runtime.sendMessage({ action: 'newLog', log: logText });
  chrome.storage.local.get(['logs'], (res) => {
    let logs = res.logs || [];
    logs.push(logText);
    if (logs.length > 200) logs.shift();
    chrome.storage.local.set({ logs });
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'startScraping') startScraping();
  else if (message.action === 'pauseScraping') { isPaused = true; logMessage("⏸️ Paused."); sendStatusUpdate(); }
  else if (message.action === 'resumeScraping') { isPaused = false; logMessage("▶️ Resumed."); sendStatusUpdate(); processQueue(); }
  else if (message.action === 'stopScraping') stopScraping();
});

async function startScraping() {
  if (isRunning) return;
  isRunning = true; isPaused = false; queue = []; results = []; activeFetch = 0;
  
  chrome.storage.local.set({ fleetData: [] });
  sendStatusUpdate();
  logMessage("🚀 Starting Fast Scraping...");

  const storageData = await chrome.storage.local.get(['mapping', 'maxTabs']);
  mapping = storageData.mapping || {};
  MAX_CONCURRENT = storageData.maxTabs || 15;

  if (Object.keys(mapping).length === 0) {
    logMessage("⚠️ No mapping found.");
    stopScraping(); return;
  }
  logMessage(`✅ Loaded ${Object.keys(mapping).length} mappings. Concurrent: ${MAX_CONCURRENT}`);

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.url.includes('dash.packzy.com')) {
    logMessage("❌ Error: Active tab is not Packzy dashboard.");
    stopScraping(); return;
  }

  logMessage("📄 Phase 1: Scraping list page...");
  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: scrapeListPage
    });
    const listData = injectionResults[0].result;
    
    if (!listData || listData.length === 0) {
      logMessage("❌ No vehicle data found.");
      stopScraping(); return;
    }
    logMessage(`✅ Found ${listData.length} vehicles.`);

    listData.forEach(item => {
      const matchedId = mapping[item.vehicleNumber] || "Not Found";
      let resultObj = {
        "Vehicle Number": item.vehicleNumber, "ID": matchedId,
        "Stolen Fuel": item.stolenFuel, "Theft Date": item.theftDate, "Theft Time": item.theftTime,
        "Model": "", "Operating Hub": ""
      };

      if (matchedId !== "Not Found") {
        queue.push({ id: matchedId, url: `https://dash.packzy.com/admin/fleet/vehicles/show/${matchedId}`, data: resultObj });
      } else {
        results.push(resultObj);
      }
    });

    logMessage(`📋 Queue: ${queue.length} items. Starting parallel fetch...`);
    saveResults();
    processQueue();

  } catch (error) {
    logMessage(`❌ Error: ${error.message}`);
    stopScraping();
  }
}

async function processQueue() {
  if (!isRunning || isPaused) return;
  if (queue.length === 0 && activeFetch === 0) {
    logMessage("🎉 All scraping completed!");
    stopScraping(); return;
  }

  while (activeFetch < MAX_CONCURRENT && queue.length > 0 && !isPaused) {
    const item = queue.shift();
    activeFetch++;
    processItem(item);
    updateProgress();
  }
}

// ⭐ Fast Regex-based processing ⭐
async function processItem(item) {
  try {
    const response = await fetch(item.url, { 
      credentials: 'include',
      headers: { 'Accept': 'text/html' }
    });
    
    if (!response.ok) {
      logMessage(`  ⚠️ [${item.id}] HTTP ${response.status}`);
      results.push(item.data);
      saveResults();
      return;
    }

    const html = await response.text();
    
    let reg = 'N/A', model = 'N/A', hub = 'N/A';

    // Reg
    const regMatch = html.match(/<[^>]*class="[^"]*vs-head__reg[^"]*"[^>]*>([\s\S]*?)<\//i);
    if (regMatch) reg = regMatch[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

    // Meta block
    const metaIndex = html.indexOf('vs-head__meta');
    if (metaIndex !== -1) {
      const chunk = html.substring(metaIndex, metaIndex + 5000);
      
      // Model - first <a>
      const aMatch = chunk.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
      if (aMatch) model = aMatch[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
      
      // Hub - span with bi-building
      const hubMatch = chunk.match(/<span[^>]*>\s*<i[^>]*bi-building[^>]*>\s*<\/i>\s*([\s\S]*?)<\/span>/i);
      if (hubMatch) hub = hubMatch[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    }

    if (reg && reg !== 'N/A') item.data["Vehicle Number"] = reg;
    item.data["Model"] = model !== 'N/A' ? model : "";
    item.data["Operating Hub"] = hub !== 'N/A' ? hub : "";

    logMessage(`  ✅ [${item.id}] ${reg} | ${model} | ${hub}`);
    
    results.push(item.data);
    saveResults();

  } catch (error) {
    logMessage(`  ❌ [${item.id}] ${error.message}`);
    results.push(item.data);
    saveResults();
  } finally {
    activeFetch--;
    updateProgress();
    processQueue();
  }
}

function stopScraping() {
  isRunning = false; isPaused = false; queue = []; activeFetch = 0;
  logMessage("🛑 Stopped."); sendStatusUpdate();
}

function saveResults() {
  chrome.storage.local.set({ fleetData: results });
  chrome.runtime.sendMessage({ action: 'dataUpdated', data: results });
}

function updateProgress() {
  const total = results.length + queue.length + activeFetch;
  const completed = results.length;
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  chrome.runtime.sendMessage({ action: 'updateProgress', percent, text: `Completed: ${completed} / ${total}` });
}

function sendStatusUpdate() {
  chrome.runtime.sendMessage({ action: 'statusUpdate', isRunning, isPaused });
}

// LIST PAGE SCRAPER
function scrapeListPage() {
  const rows = document.querySelectorAll('table.table tbody tr');
  const data = [];
  function formatVehicleNumber(raw) {
    if (!raw) return "";
    let normalized = raw.toLowerCase().replace(/[-_]/g, '-');
    let parts = normalized.split('-');
    return parts.map((part, index) => {
      if (index === 0) return 'DHM'; 
      if (part === 'ma' || part === 'm') return 'MA';
      if (part === 'a' || part === 'au') return 'AU';
      if (part === 'u') return 'U';
      if (part === 'n' || part === 'na') return 'NA';
      return part.toUpperCase();
    }).join('-');
  }
  rows.forEach((row) => {
    const tds = row.querySelectorAll('td');
    if (tds.length < 3) return;
    let vehicleNum = "";
    const mutedDiv = tds[0].querySelector('.text-muted');
    if (mutedDiv) {
      const parts = mutedDiv.innerText.split('·').map(p => p.trim());
      if (parts.length > 1) vehicleNum = formatVehicleNumber(parts[1]);
    }
    let theftDate = "", theftTime = "";
    const htmlContent = tds[2].innerHTML;
    if (htmlContent.includes('<br>')) {
      const parts = htmlContent.split('<br>');
      theftDate = parts[0].replace(/["']/g, '').trim();
      theftTime = parts[1].replace(/["']/g, '').trim();
    }
    data.push({ vehicleNumber: vehicleNum, stolenFuel: tds[1].innerText.trim(), theftDate, theftTime });
  });
  return data;
}