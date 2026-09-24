let isRunning = false;
let isPaused = false;
let queue = [];
let results = [];
let activeTabs = 0;
let MAX_CONCURRENT_TABS = 10;
let mapping = {};
let listTabId = null;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

function logMessage(msg) {
  const logText = `[${new Date().toLocaleTimeString()}] ${msg}`;
  chrome.runtime.sendMessage({ action: 'newLog', log: logText });
  chrome.storage.local.get(['logs'], (res) => {
    let logs = res.logs || [];
    logs.push(logText);
    if (logs.length > 300) logs.shift();
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
  isRunning = true; isPaused = false; queue = []; results = []; activeTabs = 0;
  
  chrome.storage.local.set({ fleetData: [] });
  sendStatusUpdate();
  logMessage("🚀 Starting Scraping Process v3...");

  const storageData = await chrome.storage.local.get(['mapping', 'maxTabs']);
  mapping = storageData.mapping || {};
  MAX_CONCURRENT_TABS = storageData.maxTabs || 10;

  if (Object.keys(mapping).length === 0) {
    logMessage("⚠️ No mapping found.");
    stopScraping(); return;
  }
  logMessage(`✅ Loaded ${Object.keys(mapping).length} mappings. Concurrent: ${MAX_CONCURRENT_TABS}`);

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.url.includes('dash.packzy.com')) {
    logMessage("❌ Error: Active tab is not Packzy dashboard.");
    stopScraping(); return;
  }
  listTabId = tab.id;

  // ═══════════════════════════════════════════════
  // PHASE 1: লিস্ট পেজ থেকে সব ডেটা + Coordinates
  // ═══════════════════════════════════════════════
  logMessage("📄 Phase 1: Scraping list page + Coordinates...");
  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: scrapeListPageWithCoordinates,
      args: [MAX_CONCURRENT_TABS]
    });
    const listData = injectionResults[0].result;
    
    if (!listData || listData.length === 0) {
      logMessage("❌ No vehicle data found.");
      stopScraping(); return;
    }
    logMessage(`✅ Found ${listData.length} vehicles with coordinates.`);

    // ═══════════════════════════════════════════════
    // PHASE 2: Queue তৈরি (Fetch + Model/Hub)
    // ═══════════════════════════════════════════════
    listData.forEach(item => {
      const matchedId = mapping[item.vehicleNumber] || "Not Found";
      let resultObj = {
        "Vehicle Number": item.vehicleNumber, "ID": matchedId,
        "Stolen Fuel": item.stolenFuel, "Theft Date": item.theftDate, "Theft Time": item.theftTime,
        "Model": "", "Operating Hub": "", "Coordinates": item.coordinates || ""
      };

      if (matchedId !== "Not Found") {
        queue.push({ id: matchedId, url: `https://dash.packzy.com/admin/fleet/vehicles/show/${matchedId}`, data: resultObj });
      } else {
        results.push(resultObj);
      }
    });

    logMessage(`📋 Phase 2: Queue with ${queue.length} items. Fetching Model & Hub...`);
    saveResults();
    processQueue();

  } catch (error) {
    logMessage(`❌ Error: ${error.message}`);
    stopScraping();
  }
}

async function processQueue() {
  if (!isRunning || isPaused) return;
  if (queue.length === 0 && activeTabs === 0) {
    logMessage("🎉 All scraping completed!");
    stopScraping(); return;
  }

  while (activeTabs < MAX_CONCURRENT_TABS && queue.length > 0 && !isPaused) {
    const item = queue.shift();
    activeTabs++;
    processItem(item);
    updateProgress();
  }
}

// ⭐ Phase 2: Fetch করে Model + Hub বের করা ⭐
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
    
    let model = 'N/A', hub = 'N/A';

    const metaIndex = html.indexOf('vs-head__meta');
    if (metaIndex !== -1) {
      const chunk = html.substring(metaIndex, metaIndex + 5000);
      
      const aMatch = chunk.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
      if (aMatch) model = aMatch[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
      
      const hubMatch = chunk.match(/<span[^>]*>\s*<i[^>]*bi-building[^>]*>\s*<\/i>\s*([\s\S]*?)<\/span>/i);
      if (hubMatch) hub = hubMatch[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    }

    item.data["Model"] = model !== 'N/A' ? model : "";
    item.data["Operating Hub"] = hub !== 'N/A' ? hub : "";

    logMessage(`  ✅ [${item.id}] ${item.data["Vehicle Number"]} | ${model} | ${hub} | ${item.data["Coordinates"]}`);
    
    results.push(item.data);
    saveResults();

  } catch (error) {
    logMessage(`  ❌ [${item.id}] ${error.message}`);
    results.push(item.data);
    saveResults();
  } finally {
    activeTabs--;
    updateProgress();
    processQueue();
  }
}

function stopScraping() {
  isRunning = false; isPaused = false; queue = []; activeTabs = 0;
  logMessage("🛑 Stopped."); sendStatusUpdate();
}

function saveResults() {
  chrome.storage.local.set({ fleetData: results });
  chrome.runtime.sendMessage({ action: 'dataUpdated', data: results });
}

function updateProgress() {
  const total = results.length + queue.length + activeTabs;
  const completed = results.length;
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  chrome.runtime.sendMessage({ action: 'updateProgress', percent, text: `Completed: ${completed} / ${total}` });
}

function sendStatusUpdate() {
  chrome.runtime.sendMessage({ action: 'statusUpdate', isRunning, isPaused });
}

// ==========================================
// ⭐ LIST PAGE SCRAPER WITH COORDINATES ⭐
// ==========================================
async function scrapeListPageWithCoordinates(maxConcurrent) {
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

  // ═══ Step 1: প্রথমে সব ডেটা কালেক্ট করা ═══
  rows.forEach((row, idx) => {
    const tds = row.querySelectorAll('td');
    if (tds.length < 3) return;
    
    let deviceId = "", vehicleNum = "";
    const mutedDiv = tds[0].querySelector('.text-muted');
    if (mutedDiv) {
      const parts = mutedDiv.innerText.split('·').map(p => p.trim());
      deviceId = parts[0] || "";
      if (parts.length > 1) vehicleNum = formatVehicleNumber(parts[1]);
    }
    
    let theftDate = "", theftTime = "";
    const htmlContent = tds[2].innerHTML;
    if (htmlContent.includes('<br>')) {
      const parts = htmlContent.split('<br>');
      theftDate = parts[0].replace(/["']/g, '').trim();
      theftTime = parts[1].replace(/["']/g, '').trim();
    }
    
    data.push({
      deviceId: deviceId,
      vehicleNumber: vehicleNum,
      stolenFuel: tds[1].innerText.trim(),
      theftDate: theftDate,
      theftTime: theftTime,
      coordinates: "",
      rowIndex: idx
    });
  });

  // ═══ Step 2: প্রতিটি Row-তে ক্লিক করে Coordinate বের করা ═══
  // একটার পর একটা (serial) ক্লিক করব — coordinate popup একটাই থাকে
  for (let i = 0; i < data.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 400)); // popup close হতে সময় দাও
    
    try {
      const targetRow = rows[data[i].rowIndex];
      if (!targetRow) continue;
      
      // আগের popup থাকলে বন্ধ করা
      const oldPopup = document.querySelector('.leaflet-popup-close-button');
      if (oldPopup) oldPopup.click();
      
      await new Promise(r => setTimeout(r, 200));
      
      // Row-তে ক্লিক করা
      targetRow.click();
      targetRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      
      // Popup ওপেন হওয়ার জন্য অপেক্ষা
      let coord = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(r => setTimeout(r, 250));
        
        // Coords বের করা — Leaflet Popup এর ভেতরের টেবিল থেকে
        const popup = document.querySelector('.leaflet-popup-content');
        if (popup) {
          const tds = popup.querySelectorAll('td');
          for (let j = 0; j < tds.length; j++) {
            const cellText = tds[j].textContent.trim().toLowerCase();
            if (cellText === 'coords' && tds[j+1]) {
              const coordText = tds[j+1].textContent.trim();
              const m = coordText.match(/([-\d.]+)\s*,\s*([-\d.]+)/);
              if (m) { coord = `${m[1]}, ${m[2]}`; break; }
            }
          }
          // ব্যাকআপ: সরাসরি পুরো popup এর HTML থেকে lat,lng প্যাটার্ন
          if (!coord) {
            const m = popup.innerHTML.match(/(2[0-9]\.\d{3,})\s*,\s*(8[0-9]\.\d{3,}|9[0-9]\.\d{3,})/);
            if (m) coord = `${m[1]}, ${m[2]}`;
          }
          if (coord) break;
        }
      }
      
      if (coord) data[i].coordinates = coord;
    } catch (e) {
      // silently continue
    }
  }
  
  return data;
}