let scrapedData = [];
let isRunning = false;
let isPaused = false;

// Load data on open
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['fleetData', 'mapping', 'logs', 'maxTabs'], (result) => {
    if (result.fleetData) {
      scrapedData = result.fleetData;
      renderTable();
    }
    if (result.mapping) {
      let mappingText = "";
      for (const [key, value] of Object.entries(result.mapping)) {
        mappingText += `${value}\t${key}\n`;
      }
      document.getElementById('mappingInput').value = mappingText;
    }
    if (result.logs) {
      const logContainer = document.getElementById('logContainer');
      logContainer.innerHTML = result.logs.map(l => `<div>${l}</div>`).join('');
      logContainer.scrollTop = logContainer.scrollHeight;
    }
    if (result.maxTabs) {
      document.getElementById('maxTabs').value = result.maxTabs;
    }
  });
});

// Listen for background messages
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'updateProgress') {
    document.getElementById('progressBar').style.width = message.percent + '%';
    document.getElementById('progressPercent').innerText = message.percent + '%';
    document.getElementById('progressLabel').innerText = message.text;
  }
  if (message.action === 'newLog') {
    const logContainer = document.getElementById('logContainer');
    const logDiv = document.createElement('div');
    logDiv.innerText = message.log;
    logContainer.appendChild(logDiv);
    logContainer.scrollTop = logContainer.scrollHeight;
  }
  if (message.action === 'dataUpdated') {
    scrapedData = message.data;
    renderTable();
  }
  if (message.action === 'statusUpdate') {
    isRunning = message.isRunning;
    isPaused = message.isPaused;
    toggleButtons(isRunning, isPaused);
  }
});

// Buttons
document.getElementById('btnStart').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'startScraping' });
  toggleButtons(true, false);
});
document.getElementById('btnPause').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'pauseScraping' });
  toggleButtons(true, true);
});
document.getElementById('btnResume').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'resumeScraping' });
  toggleButtons(true, false);
});
document.getElementById('btnStop').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stopScraping' });
  toggleButtons(false, false);
});

// Save Config (Mapping + Max Tabs)
document.getElementById('btnSaveMapping').addEventListener('click', () => {
  const text = document.getElementById('mappingInput').value;
  const maxTabs = parseInt(document.getElementById('maxTabs').value) || 5;
  const lines = text.split('\n');
  const mapping = {};

  lines.forEach(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      mapping[parts[1]] = parts[0];
    }
  });

  chrome.storage.local.set({ mapping: mapping, maxTabs: maxTabs }, () => {
    alert(`✅ Saved: ${Object.keys(mapping).length} vehicles, Max Tabs: ${maxTabs}`);
  });
});

// Exports
document.getElementById('btnExportCSV').addEventListener('click', () => {
  if (scrapedData.length === 0) return alert('No data to export!');
  const headers = ["Vehicle Number", "ID", "Stolen Fuel", "Theft Date", "Theft Time", "Model", "Operating Hub", "Engine No", "Chassis No", "Last Checkup"];
  const csvRows = [headers.join(',')];
  scrapedData.forEach(row => {
    csvRows.push(headers.map(h => `"${String(row[h] || '').replace(/"/g, '""')}"`).join(','));
  });
  downloadFile(csvRows.join('\n'), 'fleet_data.csv', 'text/csv');
});

document.getElementById('btnExportJSON').addEventListener('click', () => {
  if (scrapedData.length === 0) return alert('No data to export!');
  downloadFile(JSON.stringify(scrapedData, null, 2), 'fleet_data.json', 'application/json');
});

document.getElementById('btnClearData').addEventListener('click', () => {
  if (confirm('Delete all scraped data?')) {
    scrapedData = [];
    chrome.storage.local.set({ fleetData: [] });
    renderTable();
  }
});

// Helpers
function toggleButtons(running, paused) {
  const start = document.getElementById('btnStart'), pause = document.getElementById('btnPause');
  const resume = document.getElementById('btnResume'), stop = document.getElementById('btnStop');
  if (!running) { start.classList.remove('hidden'); pause.classList.add('hidden'); resume.classList.add('hidden'); stop.classList.add('hidden'); }
  else if (paused) { start.classList.add('hidden'); pause.classList.add('hidden'); resume.classList.remove('hidden'); stop.classList.remove('hidden'); }
  else { start.classList.add('hidden'); pause.classList.remove('hidden'); resume.classList.add('hidden'); stop.classList.remove('hidden'); }
}

function renderTable() {
  const tbody = document.getElementById('dataTableBody');
  if (scrapedData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:10px; color:#555;">No data scraped yet.</td></tr>';
    return;
  }
  tbody.innerHTML = scrapedData.map(row => `
    <tr>
      <td style="color:var(--accent); font-weight:600;">${row["Vehicle Number"] || '-'}</td>
      <td style="color:var(--text-muted);">${row["ID"] || 'Not Found'}</td>
      <td style="color:var(--danger);">${row["Stolen Fuel"] || '-'}</td>
      <td>${row["Model"] || '-'}</td>
      <td style="color:var(--text-muted);">${row["Operating Hub"] || '-'}</td>
      <td>${row["Engine No"] || '-'}</td>
    </tr>
  `).join('');
}

function downloadFile(content, fileName, mimeType) {
  const blob = new Blob(["\uFEFF" + content], { type: mimeType + ';charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}