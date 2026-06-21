function colorFor(level) {
  if (level === "dangerous") return "#dc2626";
  if (level === "moderate") return "#d97706";
  return "#15803d";
}

function labelFor(level) {
  if (level === "dangerous") return "High";
  if (level === "moderate") return "Moderate";
  return "Low";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderActivity(activity) {
  const list = document.getElementById("activity-list");
  const count = document.getElementById("scan-count");
  count.textContent = `${activity.length} scans`;

  if (!activity.length) {
    list.innerHTML = `<div class="activity"><strong>No scans yet</strong><p>Open a website, Gmail message, document, or download to start scanning.</p></div>`;
    return;
  }

  list.innerHTML = activity.slice(0, 6).map((item) => `
    <article class="activity">
      <strong>${escapeHtml(item.title || item.url || "Untitled scan")}</strong>
      <p>${item.surface} - ${new Date(item.scannedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>
      <div class="risk-line" style="color:${colorFor(item.level)}">
        <span>${labelFor(item.level)} risk</span>
        <span>${item.score}/100</span>
      </div>
    </article>
  `).join("");
}

chrome.runtime.sendMessage({ type: "GET_ACTIVITY" }, (response) => {
  renderActivity(response?.activity || []);
});

chrome.runtime.sendMessage({ type: "GET_FEEDBACK_STATS" }, (response) => {
  const feedbackCount = document.getElementById("feedback-count");
  if (feedbackCount) feedbackCount.textContent = `${response?.count || 0} labels`;
});

chrome.storage.local.get({
  veyraSettings: {
    adSupportedMode: false
  }
}, ({ veyraSettings }) => {
  const adMode = document.getElementById("ad-mode");
  const saveSettings = () => {
    const nextSettings = {
      ...veyraSettings,
      adSupportedMode: adMode.checked
    };
    chrome.storage.local.set({ veyraSettings: nextSettings }, () => {
      Object.assign(veyraSettings, nextSettings);
    });
  };

  adMode.checked = Boolean(veyraSettings.adSupportedMode);
  adMode.addEventListener("change", saveSettings);
});
