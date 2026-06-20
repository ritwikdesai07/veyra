importScripts("risk_engine.js");

const ACTIVITY_KEY = "shieldThreadRecentActivity";

async function getActivity() {
  const data = await chrome.storage.local.get({ [ACTIVITY_KEY]: [] });
  return data[ACTIVITY_KEY];
}

async function saveReport(report) {
  const activity = await getActivity();
  const next = [report, ...activity.filter((item) => item.id !== report.id)].slice(0, 25);
  await chrome.storage.local.set({ [ACTIVITY_KEY]: next, shieldThreadLatestReport: report });
  return report;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    shieldThreadSettings: {
      protectionEnabled: true,
      confirmationKeyword: "I UNDERSTAND",
      adSupportedMode: false
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SCAN_SURFACE") {
    const report = self.ShieldThreadRiskEngine.analyzeSurface({
      ...message.payload,
      url: message.payload?.url || sender.tab?.url || "",
      id: message.payload?.id || `${sender.tab?.id || "tab"}-${Date.now()}`
    });

    saveReport(report).then(sendResponse);
    return true;
  }

  if (message?.type === "GET_ACTIVITY") {
    getActivity().then((activity) => sendResponse({ activity }));
    return true;
  }

  return false;
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || delta.state.current !== "complete") return;

  const [download] = await chrome.downloads.search({ id: delta.id });
  if (!download) return;

  const report = self.ShieldThreadRiskEngine.analyzeSurface({
    surface: "download",
    title: download.filename.split(/[\\/]/).pop() || "Downloaded file",
    url: download.finalUrl || download.url || "",
    links: [download.finalUrl || download.url || ""],
    attachments: [download.filename],
    text: `${download.mime || ""} ${download.danger || ""}`
  });

  await saveReport(report);
});
