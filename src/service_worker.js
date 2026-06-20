importScripts("risk_engine.js");

const ACTIVITY_KEY = "shieldThreadRecentActivity";
const LOCAL_MODEL_ENDPOINT = "http://127.0.0.1:8765/score";
const SAFE_HOSTS_KEY = "shieldThreadSafeHosts";
const SENDER_MEMORY_KEY = "shieldThreadSenderMemory";
const SAFE_HOST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SENDER_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function getActivity() {
  const data = await chrome.storage.local.get({ [ACTIVITY_KEY]: [] });
  return data[ACTIVITY_KEY];
}

async function getSafeHosts() {
  const data = await chrome.storage.local.get({ [SAFE_HOSTS_KEY]: {} });
  return data[SAFE_HOSTS_KEY];
}

async function getSenderMemory() {
  const data = await chrome.storage.local.get({ [SENDER_MEMORY_KEY]: {} });
  return data[SENDER_MEMORY_KEY];
}

async function saveReport(report) {
  const activity = await getActivity();
  const next = [report, ...activity.filter((item) => item.id !== report.id)].slice(0, 25);
  await chrome.storage.local.set({ [ACTIVITY_KEY]: next, shieldThreadLatestReport: report });
  await updateSafetyMemory(report);
  return report;
}

function recommendationFor(level) {
  if (level === "dangerous") return "Do not proceed. Use a known trusted site or contact the sender through a separate channel.";
  if (level === "moderate") return "Proceed only if you expected this and can verify the sender, domain, and requested action.";
  return "No strong phishing indicators were found. Stay cautious with sensitive data.";
}

function hostFor(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch (_error) {
    return "Unknown URL";
  }
}

function isGoogleSearchUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "google.com" && !host.endsWith(".google.com")) return false;
    const path = url.pathname.toLowerCase();
    if (host === "google.com" && ["/", "/search", "/webhp", "/imghp", "/url"].includes(path)) return true;
    return ["/search", "/url"].includes(path) || (path === "/" && url.searchParams.has("q"));
  } catch (_error) {
    return false;
  }
}

function senderKeyFor(value) {
  const raw = String(value || "").toLowerCase();
  const address = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/)?.[0] || "";
  if (address) return address;
  const domain = raw.match(/@?([a-z0-9.-]+\.[a-z]{2,})/)?.[1] || "";
  return domain.replace(/^www\./, "");
}

function isEmailSurface(surface) {
  return surface === "email" || surface === "email-preview";
}

function isFreshTrustedSender(entry) {
  return entry?.status === "trusted" && Date.now() - Number(entry.lastSafeAt || 0) < SENDER_MEMORY_TTL_MS;
}

function hasLinkOrAttachmentRisk(report) {
  return report.findings.some((finding) => ["Links", "URL spoofing", "Brand impersonation", "Attachments", "ML URL model"].includes(finding.category));
}

function frameworkForEmail(report, payload, senderMemoryEntry) {
  const senderSeenBefore = isFreshTrustedSender(senderMemoryEntry);
  const senderFindings = report.findings.filter((finding) => finding.category.includes("Sender") || finding.category.includes("spoof"));
  const linkAttachmentFindings = report.findings.filter((finding) => ["Links", "URL spoofing", "Brand impersonation", "Attachments", "ML URL model"].includes(finding.category));
  const comprehensionFindings = report.findings.filter((finding) => ["Social engineering", "Credential harvesting", "Business email compromise", "Data access", "Attachment execution", "Callback phishing", "Data integrity"].includes(finding.category));

  return {
    name: "Assumed spoofed email framework",
    senderKey: senderKeyFor(payload.sender),
    senderSeenBefore,
    askedToCheckMail: !senderSeenBefore,
    steps: {
      automatedSenderToCloudRecipient: true,
      checkSpoofEmail: !senderSeenBefore,
      checkLinksAndAttachments: !senderSeenBefore,
      stripAndComprehend: !senderSeenBefore,
      machineFirstJudgement: report.level,
      overrideRequired: report.level !== "safe",
      mergeDecision: report.level === "dangerous" ? "declare-threat" : report.level === "moderate" ? "ask-user-before-opening" : "allow"
    },
    checks: {
      senderSpoofed: senderFindings.length > 0,
      linksOrAttachmentsSpoofed: linkAttachmentFindings.length > 0,
      comprehensionFlags: comprehensionFindings.map((finding) => finding.id)
    }
  };
}

function buildKnownSenderPassReport(payload, senderMemoryEntry) {
  return {
    id: payload.id || `${Date.now()}`,
    surface: payload.surface || "email",
    title: payload.title || "Known sender email",
    url: payload.url || "",
    score: 0,
    level: "safe",
    findings: [],
    recommendation: "Known sender has previously passed ShieldThread checks. No first-pass scan was required.",
    confirmationKeyword: "",
    model: "ShieldThread email sender-memory framework v0.3",
    framework: {
      name: "Assumed spoofed email framework",
      senderKey: senderKeyFor(payload.sender),
      senderSeenBefore: true,
      askedToCheckMail: false,
      steps: {
        automatedSenderToCloudRecipient: true,
        checkSpoofEmail: false,
        checkLinksAndAttachments: false,
        stripAndComprehend: false,
        machineFirstJudgement: "safe",
        overrideRequired: false,
        mergeDecision: "break-known-sender"
      },
      checks: {
        senderSpoofed: false,
        linksOrAttachmentsSpoofed: false,
        comprehensionFlags: []
      },
      previousSafeAt: senderMemoryEntry?.lastSafeAt || 0
    },
    scannedAt: new Date().toISOString()
  };
}

function urlFromLink(link) {
  if (typeof link === "string") return link;
  if (link && typeof link.href === "string") return link.href;
  if (link && typeof link.url === "string") return link.url;
  return "";
}

function collectUrlsForModel(payload, fallbackUrl) {
  const urls = new Set();
  const surface = payload?.surface || "";

  if (["website", "download"].includes(surface) && (payload?.url || fallbackUrl)) {
    urls.add(payload.url || fallbackUrl);
  }

  (payload?.links || []).map(urlFromLink).forEach((url) => {
    if (/^https?:\/\//i.test(url)) urls.add(url);
  });

  return [...urls].filter((url) => /^https?:\/\//i.test(url)).slice(0, 25);
}

async function fetchLocalModelScores(urls) {
  if (!urls.length) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 850);
  try {
    const response = await fetch(LOCAL_MODEL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
      signal: controller.signal
    });
    if (!response.ok) return { status: "error", error: `HTTP ${response.status}` };
    return await response.json();
  } catch (error) {
    return { status: "unavailable", error: error?.name === "AbortError" ? "timeout" : String(error?.message || error) };
  } finally {
    clearTimeout(timeout);
  }
}

function addModelFinding(report, result) {
  const probability = Number(result.phishing_probability || 0);
  const predictedPhishing = result.predicted_label === 1 || result.predicted_label === "1" || String(result.predicted_label).toLowerCase() === "phishing";
  if (probability < 0.7 && !predictedPhishing) return;

  const points = probability >= 0.85 || predictedPhishing ? 24 : 16;
  report.findings.push({
    id: "xgboost-url-phishing",
    severity: points >= 22 ? "high" : "medium",
    points,
    category: "ML URL model",
    where: hostFor(result.url),
    detail: `Local XGBoost URL model estimated ${Math.round(probability * 100)}% phishing probability.`,
    advice: "Treat this URL as suspicious unless you can verify the destination independently.",
    source: "Local XGBoostClassifier.pickle.dat"
  });
}

function recomputeReportRisk(report) {
  const raw = report.findings.reduce((sum, finding) => sum + (finding.points || 0), 0);
  const highCount = report.findings.filter((finding) => finding.severity === "high").length;
  const diversityBonus = new Set(report.findings.map((finding) => finding.category)).size * 3;
  report.score = Math.min(100, raw + diversityBonus + Math.max(0, highCount - 1) * 6);
  report.level = self.ShieldThreadRiskEngine.levelForScore(report.score);
  report.recommendation = recommendationFor(report.level);
  report.confirmationKeyword = report.level === "safe" ? "" : "I UNDERSTAND";
  report.findings.sort((a, b) => (b.points || 0) - (a.points || 0));
}

async function enrichReportWithLocalModel(report, payload, fallbackUrl) {
  const urls = collectUrlsForModel(payload, fallbackUrl);
  const modelResponse = await fetchLocalModelScores(urls);
  if (!modelResponse || modelResponse.status === "unavailable") return report;

  report.ml = {
    status: modelResponse.status || "ok",
    model: modelResponse.model || "local-xgboost-url-model",
    results: (modelResponse.results || []).slice(0, 10)
  };

  (modelResponse.results || []).forEach((result) => addModelFinding(report, result));
  recomputeReportRisk(report);
  report.model = `${report.model} + optional local XGBoost URL model`;
  return report;
}

async function buildSurfaceReport(payload, options = {}) {
  const surface = payload?.surface || "website";
  if (isEmailSurface(surface)) {
    const senderKey = senderKeyFor(payload.sender);
    const senderMemory = await getSenderMemory();
    const senderMemoryEntry = senderKey ? senderMemory[senderKey] : null;

    if (isFreshTrustedSender(senderMemoryEntry)) {
      return buildKnownSenderPassReport(payload, senderMemoryEntry);
    }

    const report = self.ShieldThreadRiskEngine.analyzeSurface(payload);
    await enrichReportWithLocalModel(report, payload, payload.url);
    report.framework = frameworkForEmail(report, payload, senderMemoryEntry);
    if (!options.preview) await updateSenderMemory(report, payload);
    return report;
  }

  const report = self.ShieldThreadRiskEngine.analyzeSurface(payload);
  return enrichReportWithLocalModel(report, payload, payload.url);
}

async function updateSenderMemory(report, payload) {
  if (!isEmailSurface(payload?.surface)) return;
  const key = senderKeyFor(payload.sender);
  if (!key) return;

  const memory = await getSenderMemory();
  if (report.level === "safe" && !hasLinkOrAttachmentRisk(report)) {
    memory[key] = {
      status: "trusted",
      lastSafeAt: Date.now(),
      expiresAt: Date.now() + SENDER_MEMORY_TTL_MS,
      title: report.title || "",
      source: "ShieldThread safe full-email scan"
    };
  } else if (report.level !== "safe") {
    memory[key] = {
      status: "suspicious",
      lastRiskAt: Date.now(),
      lastLevel: report.level,
      title: report.title || "",
      source: "ShieldThread risky full-email scan"
    };
  }
  await chrome.storage.local.set({ [SENDER_MEMORY_KEY]: memory });
}

async function updateSafetyMemory(report) {
  if (report.surface !== "website") return;
  const host = hostFor(report.url);
  if (!host || host === "Unknown URL") return;

  const safeHosts = await getSafeHosts();
  if (report.level === "safe") {
    safeHosts[host] = {
      status: "safe",
      lastSafeAt: Date.now(),
      expiresAt: Date.now() + SAFE_HOST_TTL_MS,
      title: report.title || "",
      source: "ShieldThread safe website scan"
    };
  } else {
    delete safeHosts[host];
  }
  await chrome.storage.local.set({ [SAFE_HOSTS_KEY]: safeHosts });
}

function chromeHistorySearch(query) {
  return new Promise((resolve) => {
    if (!chrome.history?.search) {
      resolve([]);
      return;
    }
    chrome.history.search(query, (results) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(results || []);
    });
  });
}

async function hasPriorHistoryForHost(host) {
  const startTime = Date.now() - 180 * 24 * 60 * 60 * 1000;
  const endTime = Date.now() - 8000;
  const results = await chromeHistorySearch({ text: host, startTime, endTime, maxResults: 12 });
  return results.some((item) => {
    try {
      return new URL(item.url).hostname.replace(/^www\./, "").toLowerCase() === host;
    } catch (_error) {
      return false;
    }
  });
}

async function shouldGateWebsite(url) {
  if (!url || isGoogleSearchUrl(url)) {
    return { shouldGate: false, reason: "search-or-empty" };
  }

  const host = hostFor(url);
  if (!host || host === "Unknown URL") {
    return { shouldGate: true, reason: "unknown-host" };
  }

  const safeHosts = await getSafeHosts();
  const entry = safeHosts[host];
  const stillFresh = entry?.status === "safe"
    && Date.now() < Number(entry.expiresAt || Number(entry.lastSafeAt || 0) + SAFE_HOST_TTL_MS);
  if (stillFresh && await hasPriorHistoryForHost(host)) {
    return { shouldGate: false, reason: "previously-safe-history", host };
  }

  return { shouldGate: true, reason: "new-or-unverified-site", host };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    shieldThreadSettings: {
      protectionEnabled: true,
      confirmationKeyword: "I UNDERSTAND",
      adSupportedMode: false,
      localModelEndpoint: LOCAL_MODEL_ENDPOINT
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SHOULD_GATE_WEBSITE") {
    shouldGateWebsite(message.payload?.url || sender.tab?.url || "").then(sendResponse);
    return true;
  }

  if (message?.type === "SCAN_SURFACE") {
    const payload = {
      ...message.payload,
      url: message.payload?.url || sender.tab?.url || "",
      id: message.payload?.id || `${sender.tab?.id || "tab"}-${Date.now()}`
    };

    buildSurfaceReport(payload)
      .then(saveReport)
      .then(sendResponse);
    return true;
  }

  if (message?.type === "SCAN_EMAIL_PREVIEW") {
    const payload = {
      ...message.payload,
      surface: "email-preview",
      id: message.payload?.id || `email-preview-${Date.now()}`
    };
    buildSurfaceReport(payload, { preview: true }).then(sendResponse);
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

  await saveReport(await enrichReportWithLocalModel(report, {
    surface: "download",
    url: download.finalUrl || download.url || "",
    links: [download.finalUrl || download.url || ""]
  }, download.finalUrl || download.url || ""));
});
