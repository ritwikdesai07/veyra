importScripts("risk_engine.js");
try {
  importScripts("secrets.local.js");
} catch (_error) {
  self.VEYRA_LOCAL_SECRETS = self.VEYRA_LOCAL_SECRETS || {};
}

const ACTIVITY_KEY = "veyraRecentActivity";
const FEEDBACK_KEY = "veyraFeedback";
const EMAIL_REPORT_CACHE_KEY = "veyraEmailReportCache";
const LOCAL_MODEL_ENDPOINT = "http://127.0.0.1:8765/score";
const LOCAL_AI_ENDPOINT = "http://127.0.0.1:8766/analyze";
const SAFE_HOSTS_KEY = "veyraSafeHosts";
const SENDER_MEMORY_KEY = "veyraSenderMemory";
const SENDER_PROFILE_KEY = "veyraSenderProfiles";
const SAFE_HOST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SENDER_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const LEGACY_AI_MODELS = new Set(["", "gemini-2.5-flash", "gpt-4.1-mini"]);
const pendingEmailPrescans = new Map();

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

async function getSenderProfiles() {
  const data = await chrome.storage.local.get({ [SENDER_PROFILE_KEY]: {} });
  return data[SENDER_PROFILE_KEY];
}

async function getFeedback() {
  const data = await chrome.storage.local.get({ [FEEDBACK_KEY]: [] });
  return data[FEEDBACK_KEY];
}

async function getEmailReportCache() {
  const data = await chrome.storage.local.get({ [EMAIL_REPORT_CACHE_KEY]: {} });
  return data[EMAIL_REPORT_CACHE_KEY] || {};
}

function emailReportCacheKey(payload) {
  return String(payload?.matchKey || `${senderKeyFor(payload?.sender)}|${String(payload?.subject || payload?.title || "").toLowerCase().trim()}`).slice(0, 260);
}

function emailReportSubjectKey(payload) {
  return `subject|${String(payload?.subject || payload?.title || "").toLowerCase().replace(/^(re|fw|fwd):\s*/i, "").replace(/\s+/g, " ").trim()}`.slice(0, 220);
}

async function getCachedEmailReport(payload) {
  const keys = [emailReportCacheKey(payload), emailReportSubjectKey(payload)].filter((key) => key && key !== "|" && key !== "subject|");
  if (!keys.length) return null;

  const cache = await getEmailReportCache();
  const entry = keys.map((key) => cache[key]).find(Boolean);
  if (!entry?.report || Date.now() - Number(entry.savedAt || 0) > 24 * 60 * 60 * 1000) return null;
  return {
    ...entry.report,
    surface: payload?.surface || entry.report.surface,
    fromFullEmailCache: true
  };
}

async function saveEmailReportCache(payload, report) {
  if (payload?.surface !== "email") return;
  const keys = [emailReportCacheKey(payload), emailReportSubjectKey(payload)].filter((key) => key && key !== "|" && key !== "subject|");
  if (!keys.length) return;

  const cache = await getEmailReportCache();
  const entry = {
    savedAt: Date.now(),
    report: {
      ...report,
      surface: "email",
      cachedFrom: "full-email-scan"
    }
  };
  keys.forEach((key) => {
    cache[key] = entry;
  });

  const entries = Object.entries(cache)
    .sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0))
    .slice(0, 200);
  await chrome.storage.local.set({ [EMAIL_REPORT_CACHE_KEY]: Object.fromEntries(entries) });
}

function openEmailPrescanTab(payload) {
  const threadUrl = String(payload?.threadUrl || "");
  if (!threadUrl || !/^https:\/\/mail\.google\.com\//i.test(threadUrl)) {
    return Promise.resolve({ ok: false, reason: "missing-thread-url" });
  }

  const key = emailReportCacheKey(payload) || emailReportSubjectKey(payload);
  if (pendingEmailPrescans.has(key)) return Promise.resolve({ ok: true, reason: "already-pending" });

  return new Promise((resolve) => {
    chrome.tabs.create({ url: threadUrl, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab?.id) {
        resolve({ ok: false, reason: chrome.runtime.lastError?.message || "tab-create-failed" });
        return;
      }
      pendingEmailPrescans.set(key, { tabId: tab.id, startedAt: Date.now() });
      setTimeout(() => {
        const pending = pendingEmailPrescans.get(key);
        if (pending?.tabId === tab.id) {
          pendingEmailPrescans.delete(key);
          chrome.tabs.remove(tab.id, () => void chrome.runtime.lastError);
        }
      }, 45000);
      resolve({ ok: true, tabId: tab.id });
    });
  });
}

function finishEmailPrescan(tabId) {
  if (!tabId) return;
  for (const [key, pending] of pendingEmailPrescans.entries()) {
    if (pending.tabId === tabId) pendingEmailPrescans.delete(key);
  }
  chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
}

async function getSettings() {
  const data = await chrome.storage.local.get({
    veyraSettings: {
      protectionEnabled: true,
      confirmationKeyword: "I UNDERSTAND",
      adSupportedMode: false,
      localModelEndpoint: LOCAL_MODEL_ENDPOINT
    }
  });
  const settings = data.veyraSettings || {};
  const localSecrets = self.VEYRA_LOCAL_SECRETS || {};
  return {
    ...settings,
    openaiApiKey: localSecrets.OPENAI_API_KEY || "",
    openaiModel: LEGACY_AI_MODELS.has(String(localSecrets.OPENAI_MODEL || "").trim())
      ? DEFAULT_OPENAI_MODEL
      : (localSecrets.OPENAI_MODEL || DEFAULT_OPENAI_MODEL)
  };
}

async function saveReport(report) {
  const activity = await getActivity();
  const next = [report, ...activity.filter((item) => item.id !== report.id)].slice(0, 25);
  await chrome.storage.local.set({ [ACTIVITY_KEY]: next, veyraLatestReport: report });
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

function senderDomainFor(value) {
  return senderKeyFor(value).split("@").pop() || "";
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

function addServiceFinding(report, finding) {
  const key = `${finding.id}|${finding.where}|${finding.detail}`;
  if (report.findings.some((existing) => `${existing.id}|${existing.where}|${existing.detail}` === key)) return;
  report.findings.push({
    severity: finding.severity || "medium",
    points: finding.points || 8,
    category: finding.category,
    where: finding.where,
    detail: finding.detail,
    advice: finding.advice,
    source: finding.source || "Veyra AI layer",
    id: finding.id
  });
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
    recommendation: "Known sender has previously passed Veyra checks. No first-pass scan was required.",
    confirmationKeyword: "",
    model: "Veyra email sender-memory framework v0.3",
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
  const canonical = new Set();
  const surface = payload?.surface || "";

  if (["website", "download"].includes(surface) && (payload?.url || fallbackUrl)) {
    urls.add(payload.url || fallbackUrl);
  }

  // Sublinks found within the page (or email body) are checked the same
  // way: every link gets pulled in here, then reduced to scheme+host below,
  // just like the page URL itself and just like an email sender is reduced
  // to its domain.
  (payload?.links || []).map(urlFromLink).forEach((url) => {
    if (/^https?:\/\//i.test(url)) urls.add(url);
  });

  // Cut each URL down to its first part (scheme + host) before it goes to
  // the model, the same way an email address is reduced to its domain.
  // This also de-duplicates links that only differ by path/query/IDs, so
  // a site with 25 links to the same domain only costs the model 1 call.
  urls.forEach((url) => {
    const clean = self.VeyraRiskEngine.canonicalizeUrlForCheck(url);
    if (clean.href) canonical.add(clean.href);
  });

  return [...canonical].filter((url) => /^https?:\/\//i.test(url)).slice(0, 25);
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
  report.level = self.VeyraRiskEngine.levelForScore(report.score);
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

function redactedPayloadForAi(payload, report) {
  return {
    surface: payload?.surface || report.surface,
    title: String(payload?.title || report.title || "").slice(0, 160),
    host: hostFor(payload?.url || report.url || ""),
    features: report.features || self.VeyraRiskEngine.extractSurfaceFeatures(payload || {}),
    findingIds: report.findings.map((finding) => finding.id).slice(0, 20),
    findingCategories: report.findings.map((finding) => finding.category).slice(0, 20)
  };
}

async function fetchLocalAiAnalysis(payload, report) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  const bodyPayload = isEmailSurface(payload?.surface)
    ? {
        ...payload,
        features: report.features || self.VeyraRiskEngine.extractSurfaceFeatures(payload || {}),
        findingIds: report.findings.map((finding) => finding.id).slice(0, 20),
        findingCategories: report.findings.map((finding) => finding.category).slice(0, 20)
      }
    : redactedPayloadForAi(payload, report);
  try {
    const response = await fetch(LOCAL_AI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyPayload),
      signal: controller.signal
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function confidenceForReport(report) {
  const count = report.findings.length;
  const hasMl = Boolean(report.ml?.results?.length);
  const highCount = report.findings.filter((finding) => finding.severity === "high").length;
  if (hasMl && count >= 2) return "high";
  if (highCount || count >= 3) return "medium-high";
  if (count >= 1) return "medium";
  return "low";
}

function buildAiNarrative(report) {
  const top = report.findings.slice(0, 4);
  const riskDrivers = top.map((finding) => `${finding.category} at ${finding.where}`);
  const impact = report.level === "dangerous"
    ? "This can lead to credential theft, payment fraud, malware execution, or data exposure if the user proceeds."
    : report.level === "moderate"
      ? "This may impact the user if the request is unexpected or the domain cannot be independently verified."
      : "No strong evidence suggests immediate data compromise, but sensitive actions should still be verified.";
  const summary = top.length
    ? `Veyra found ${top.length} main signal${top.length === 1 ? "" : "s"}: ${riskDrivers.join("; ")}.`
    : "Veyra did not find strong phishing or spoofing evidence in the available page data.";

  return {
    mode: "evidence-bound local report",
    summary,
    riskDrivers,
    possibleImpact: impact,
    advice: report.recommendation,
    confidence: confidenceForReport(report),
    evidenceIds: top.map((finding) => finding.id)
  };
}

function extractEmailBodyText(payload) {
  const subject = String(payload?.subject || payload?.title || "");
  const text = String(payload?.text || "");
  return text.replace(subject, "").trim().slice(0, 6000);
}

function normalizeTopicDistance(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(0, Math.min(1, number));
}

function parseOpenAiJson(content) {
  const raw = String(content || "").trim();
  try {
    return JSON.parse(raw);
  } catch (_error) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (__error) {
      return null;
    }
  }
}

const STOP_TOPIC_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do", "does", "for", "from", "has", "have", "hey", "hi", "i", "in", "is", "it", "just", "know", "let", "me", "my", "of", "on", "or", "our", "please", "re", "soon", "that", "the", "this", "to", "was", "we", "with", "you", "your"
]);

const TOPIC_CATEGORY_KEYWORDS = {
  security: ["alert", "breach", "compromise", "compromised", "danger", "dangerous", "fraud", "hack", "hacked", "malicious", "malware", "phishing", "risk", "scam", "security", "spoof", "suspicious", "threat", "virus"],
  finance: ["account", "bank", "billing", "card", "charge", "deposit", "invoice", "money", "pay", "payment", "payroll", "refund", "subscription", "tax", "wire"],
  credentials: ["2fa", "code", "credential", "login", "otp", "password", "reset", "signin", "verify"],
  work: ["agenda", "calendar", "client", "contract", "deadline", "document", "meeting", "memo", "project", "proposal", "report", "schedule", "task"],
  social: ["birthday", "coffee", "dinner", "family", "free", "hang", "lunch", "party", "plan", "soon", "weekend"],
  food: ["cream", "dessert", "food", "ice", "sprinkle", "sprinkles", "summer", "treat", "vanilla"],
  promo: ["coupon", "deal", "discount", "offer", "promo", "sale"]
};

const SENSITIVE_TOPIC_CATEGORIES = new Set(["security", "finance", "credentials"]);

function topicKeywords(value) {
  return [...new Set(String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOP_TOPIC_WORDS.has(word))
  )].slice(0, 12);
}

function lexicalTopicDistance(subject, body) {
  const subjectWords = topicKeywords(subject);
  const bodyWords = topicKeywords(body);
  if (!subjectWords.length || !bodyWords.length) return 0.5;

  const overlap = subjectWords.filter((word) => bodyWords.includes(word)).length;
  const union = new Set([...subjectWords, ...bodyWords]).size || 1;
  const jaccard = overlap / union;
  if (jaccard > 0) return Math.max(0.15, 1 - jaccard);

  return 0.9;
}

function topicCategories(words) {
  const categories = new Set();
  Object.entries(TOPIC_CATEGORY_KEYWORDS).forEach(([category, keywords]) => {
    if (words.some((word) => keywords.some((keyword) => word === keyword || word.startsWith(keyword) || keyword.startsWith(word)))) {
      categories.add(category);
    }
  });
  return [...categories];
}

function localTopicDistance(subject, body) {
  const subjectWords = topicKeywords(subject);
  const bodyWords = topicKeywords(body);
  if (!subjectWords.length || !bodyWords.length) {
    return {
      distance: 0.25,
      reason: "Local fallback did not find enough topic words to judge a mismatch.",
      subjectCategories: [],
      bodyCategories: []
    };
  }

  const subjectCategories = topicCategories(subjectWords);
  const bodyCategories = topicCategories(bodyWords);
  const sharedCategories = subjectCategories.filter((category) => bodyCategories.includes(category));
  const sensitiveSubject = subjectCategories.some((category) => SENSITIVE_TOPIC_CATEGORIES.has(category));
  const sensitiveBody = bodyCategories.some((category) => SENSITIVE_TOPIC_CATEGORIES.has(category));
  const lexical = lexicalTopicDistance(subject, body);

  if (sharedCategories.length) {
    return {
      distance: Math.min(0.35, lexical),
      reason: `Local fallback found the same broad topic area: ${sharedCategories.join(", ")}.`,
      subjectCategories,
      bodyCategories
    };
  }

  if (sensitiveSubject || sensitiveBody) {
    return {
      distance: 0.9,
      reason: "Local fallback found a sensitive subject/body topic conflict.",
      subjectCategories,
      bodyCategories
    };
  }

  if (subjectCategories.length && bodyCategories.length) {
    return {
      distance: 0.62,
      reason: "Local fallback found different broad topic areas, but no sensitive action language.",
      subjectCategories,
      bodyCategories
    };
  }

  return {
    distance: lexical >= 0.9 ? 0.38 : Math.min(0.5, lexical),
    reason: lexical >= 0.9
      ? "Local fallback found no shared keywords, but no sensitive mismatch evidence."
      : "Local fallback found partial keyword overlap.",
    subjectCategories,
    bodyCategories
  };
}

function buildLocalTopicMatch(subject, body) {
  const result = localTopicDistance(subject, body);
  const distance = result.distance;
  return {
    status: "ok",
    model: "Veyra local topic comparator",
    headerTopic: {
      topic: subject,
      intent: result.subjectCategories.join(", ") || "general subject"
    },
    bodyTopic: {
      topic: body,
      intent: result.bodyCategories.join(", ") || "general body"
    },
    sharedIdeaRange: distance <= 0.55 ? "The subject and body are close enough for a low-risk semantic match." : "The subject and body appear to be in different broad topic areas.",
    topicDistance: distance,
    match: distance <= 0.55,
    reason: result.reason
  };
}

async function fetchOpenAiTopicMatch(payload) {
  if (!isEmailSurface(payload?.surface)) return null;

  const subject = String(payload?.subject || payload?.title || "").trim();
  const body = extractEmailBodyText(payload);
  if (!subject || !body.trim()) {
    return { status: "skipped", reason: "Need both a subject and email body text for topic comparison." };
  }

  if (body.length < 40) {
    return buildLocalTopicMatch(subject, body);
  }

  const settings = await getSettings();
  const apiKey = String(settings.openaiApiKey || "").trim();
  if (!apiKey) {
    return buildLocalTopicMatch(subject, body);
  }

  const model = String(settings.openaiModel || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5500);
  try {
    const response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You compare an email subject/header with the email body for broad semantic consistency.",
              "Do not require exact keyword overlap. Treat different wording as safe when the subject and body are in the same general idea range.",
              "Return JSON only with: headerTopic, bodyTopic, sharedIdeaRange, topicDistance, match, reason.",
              "topicDistance is 0 for same idea, 0.35 for related but shifted, 0.65 for suspiciously different, and 1 for unrelated."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify({
              subject,
              headerText: String(payload?.headerText || "").slice(0, 1200),
              body: body.slice(0, 6000)
            })
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const fallback = buildLocalTopicMatch(subject, body);
      return {
        ...fallback,
        model: `${fallback.model} after ChatGPT HTTP ${response.status}`
      };
    }

    const data = await response.json();
    const parsed = parseOpenAiJson(data?.choices?.[0]?.message?.content);
    if (!parsed) {
      return {
        ...buildLocalTopicMatch(subject, body),
        model: "Veyra local topic comparator after invalid ChatGPT JSON"
      };
    }

    const distance = normalizeTopicDistance(parsed.topicDistance);
    return {
      status: "ok",
      model,
      headerTopic: {
        topic: String(parsed.headerTopic || subject).slice(0, 120),
        intent: String(parsed.headerIntent || "").slice(0, 120)
      },
      bodyTopic: {
        topic: String(parsed.bodyTopic || "").slice(0, 120),
        intent: String(parsed.bodyIntent || "").slice(0, 120)
      },
      sharedIdeaRange: String(parsed.sharedIdeaRange || "").slice(0, 160),
      topicDistance: distance,
      match: Boolean(parsed.match) || distance <= 0.55,
      reason: String(parsed.reason || "").slice(0, 260)
    };
  } catch (error) {
    return {
      ...buildLocalTopicMatch(subject, body),
      model: error?.name === "AbortError"
        ? "Veyra local topic comparator after ChatGPT timeout"
        : "Veyra local topic comparator after ChatGPT error"
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichReportWithOpenAiTopicMatch(report, payload) {
  const topicMatch = await fetchOpenAiTopicMatch(payload);
  if (!topicMatch) return report;

  report.topicMatch = topicMatch;
  if (topicMatch.status !== "ok") return report;

  const distance = normalizeTopicDistance(topicMatch.topicDistance);
  if (distance > 0.55) {
    const severe = distance >= 0.78;
    addServiceFinding(report, {
      id: "chatgpt-subject-body-topic-distance",
      severity: severe ? "high" : "medium",
      points: severe ? 26 : Math.max(12, Math.round(12 + (distance - 0.55) * 48)),
      category: "AI topic model",
      where: payload?.subject || payload?.title || "Email subject",
      detail: `ChatGPT estimated subject/body topic distance at ${Math.round(distance * 100)}%. ${topicMatch.reason}`,
      advice: severe ? "Treat this as suspicious until the sender confirms the message through another channel." : "Read carefully and verify the request if it asks for action, files, payments, or credentials.",
      source: topicMatch.model || "ChatGPT topic comparison"
    });
    recomputeReportRisk(report);
  }

  report.model = `${report.model} + ChatGPT broad topic comparison`;
  return report;
}

async function enrichReportWithAi(report, payload) {
  const localAi = await fetchLocalAiAnalysis(payload, report);
  if (localAi?.findings?.length) {
    localAi.findings.slice(0, 8).forEach((finding) => addServiceFinding(report, {
      id: finding.id || "local-ai-finding",
      severity: finding.severity || "medium",
      points: Number(finding.points || 12),
      category: finding.category || "AI model",
      where: finding.where || hostFor(payload?.url || report.url),
      detail: finding.detail || "Local AI model returned an additional risk signal.",
      advice: finding.advice || "Verify this item before proceeding.",
      source: localAi.model || "Local Veyra AI endpoint"
    }));
    recomputeReportRisk(report);
  }

  report.ai = localAi?.narrative || buildAiNarrative(report);
  report.model = `${report.model} + AI feature/report layer v0.4`;
  return report;
}

function senderProfileKey(payload) {
  return senderKeyFor(payload?.sender || "");
}

async function enrichReportWithSenderAnomaly(report, payload, senderMemoryEntry) {
  if (!isEmailSurface(payload?.surface)) return report;
  const key = senderProfileKey(payload);
  if (!key) return report;

  const profiles = await getSenderProfiles();
  const profile = profiles[key];
  const domain = senderDomainFor(payload.sender);
  const domainProfiles = Object.values(profiles).filter((entry) => entry.domain === domain);
  const linkCount = Array.isArray(payload.links) ? payload.links.length : 0;
  const attachmentCount = Array.isArray(payload.attachments) ? payload.attachments.length : 0;

  if (!profile && (linkCount || attachmentCount) && !isFreshTrustedSender(senderMemoryEntry)) {
    addServiceFinding(report, {
      id: "new-sender-with-risk-objects",
      severity: "medium",
      points: 14,
      category: "Sender relationship model",
      where: key,
      detail: "This sender has no local trust history and the message contains links or attachments.",
      advice: "Verify the sender before opening links or files.",
      source: "Veyra sender anomaly model"
    });
  }

  if (senderMemoryEntry?.status === "suspicious") {
    addServiceFinding(report, {
      id: "previously-suspicious-sender",
      severity: "high",
      points: 22,
      category: "Sender relationship model",
      where: key,
      detail: "This sender was previously associated with a risky Veyra scan.",
      advice: "Use a separate trusted channel before responding or clicking.",
      source: "Veyra sender anomaly model"
    });
  }

  if (!profile && domainProfiles.length >= 3 && report.level !== "safe") {
    addServiceFinding(report, {
      id: "new-address-on-known-domain-risky",
      severity: "medium",
      points: 12,
      category: "Sender relationship model",
      where: domain,
      detail: "The domain is familiar, but this specific sender address is new and the message has risk signals.",
      advice: "Confirm whether this sender address is expected.",
      source: "Veyra sender graph model"
    });
  }

  recomputeReportRisk(report);
  return report;
}

async function buildSurfaceReport(payload, options = {}) {
  const surface = payload?.surface || "website";
  if (isEmailSurface(surface)) {
    if (options.preview) {
      const cachedReport = await getCachedEmailReport(payload);
      if (cachedReport) return cachedReport;
    }

    const senderKey = senderKeyFor(payload.sender);
    const senderMemory = await getSenderMemory();
    const senderMemoryEntry = senderKey ? senderMemory[senderKey] : null;

    if (surface === "email" && isFreshTrustedSender(senderMemoryEntry)) {
      return buildKnownSenderPassReport(payload, senderMemoryEntry);
    }

    const report = self.VeyraRiskEngine.analyzeSurface(payload);
    await enrichReportWithLocalModel(report, payload, payload.url);
    await enrichReportWithOpenAiTopicMatch(report, payload);
    await enrichReportWithAi(report, payload);
    report.framework = frameworkForEmail(report, payload, senderMemoryEntry);
    if (!options.preview) await updateSenderMemory(report, payload);
    if (!options.preview) await updateSenderProfile(report, payload);
    if (!options.preview) await saveEmailReportCache(payload, report);
    return report;
  }

  const report = self.VeyraRiskEngine.analyzeSurface(payload);
  await enrichReportWithLocalModel(report, payload, payload.url);
  return enrichReportWithAi(report, payload);
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
      source: "Veyra safe full-email scan"
    };
  } else if (report.level !== "safe") {
    memory[key] = {
      status: "suspicious",
      lastRiskAt: Date.now(),
      lastLevel: report.level,
      title: report.title || "",
      source: "Veyra risky full-email scan"
    };
  }
  await chrome.storage.local.set({ [SENDER_MEMORY_KEY]: memory });
}

async function updateSenderProfile(report, payload) {
  if (!isEmailSurface(payload?.surface)) return;
  const key = senderProfileKey(payload);
  if (!key) return;

  const profiles = await getSenderProfiles();
  const previous = profiles[key] || { count: 0, safeCount: 0, riskyCount: 0 };
  profiles[key] = {
    ...previous,
    count: Number(previous.count || 0) + 1,
    safeCount: Number(previous.safeCount || 0) + (report.level === "safe" ? 1 : 0),
    riskyCount: Number(previous.riskyCount || 0) + (report.level !== "safe" ? 1 : 0),
    domain: senderDomainFor(payload.sender),
    lastSubject: report.title || "",
    lastLevel: report.level,
    lastSeenAt: Date.now(),
    averageLinks: Math.round(((Number(previous.averageLinks || 0) * Number(previous.count || 0)) + (payload.links?.length || 0)) / (Number(previous.count || 0) + 1)),
    averageAttachments: Math.round(((Number(previous.averageAttachments || 0) * Number(previous.count || 0)) + (payload.attachments?.length || 0)) / (Number(previous.count || 0) + 1))
  };
  await chrome.storage.local.set({ [SENDER_PROFILE_KEY]: profiles });
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
      source: "Veyra safe website scan"
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
  chrome.storage.local.get({
    veyraSettings: {}
  }, ({ veyraSettings }) => {
    chrome.storage.local.set({
      veyraSettings: {
        protectionEnabled: true,
        confirmationKeyword: "I UNDERSTAND",
        adSupportedMode: false,
        localModelEndpoint: LOCAL_MODEL_ENDPOINT,
        ...veyraSettings
      }
    });
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

  if (message?.type === "GET_EMAIL_FULL_REPORT") {
    getCachedEmailReport(message.payload || {}).then((report) => sendResponse({ report }));
    return true;
  }

  if (message?.type === "PRESCAN_EMAIL_THREAD") {
    openEmailPrescanTab(message.payload || {}).then(sendResponse);
    return true;
  }

  if (message?.type === "EMAIL_PRESCAN_DONE") {
    finishEmailPrescan(sender.tab?.id);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "GET_ACTIVITY") {
    getActivity().then((activity) => sendResponse({ activity }));
    return true;
  }

  if (message?.type === "SAVE_FEEDBACK") {
    saveFeedback(message.payload || {}).then(sendResponse);
    return true;
  }

  if (message?.type === "GET_FEEDBACK_STATS") {
    getFeedback().then((feedback) => sendResponse({
      count: feedback.length,
      phishing: feedback.filter((item) => item.label === "phishing").length,
      safe: feedback.filter((item) => item.label === "safe").length,
      tooStrict: feedback.filter((item) => item.label === "too-strict").length
    }));
    return true;
  }

  return false;
});

async function saveFeedback(payload) {
  const feedback = await getFeedback();
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    reportId: payload.reportId || "",
    label: payload.label || "unknown",
    surface: payload.surface || "",
    level: payload.level || "",
    score: Number(payload.score || 0),
    findingIds: Array.isArray(payload.findingIds) ? payload.findingIds.slice(0, 20) : [],
    createdAt: new Date().toISOString(),
    source: "user-feedback-loop"
  };
  const next = [item, ...feedback].slice(0, 500);
  await chrome.storage.local.set({ [FEEDBACK_KEY]: next });
  return { ok: true, item };
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || delta.state.current !== "complete") return;

  const [download] = await chrome.downloads.search({ id: delta.id });
  if (!download) return;

  const report = self.VeyraRiskEngine.analyzeSurface({
    surface: "download",
    title: download.filename.split(/[\\/]/).pop() || "Downloaded file",
    url: download.finalUrl || download.url || "",
    links: [download.finalUrl || download.url || ""],
    attachments: [download.filename],
    text: `${download.mime || ""} ${download.danger || ""}`
  });

  await enrichReportWithLocalModel(report, {
    surface: "download",
    url: download.finalUrl || download.url || "",
    links: [download.finalUrl || download.url || ""]
  }, download.finalUrl || download.url || "");
  await saveReport(await enrichReportWithAi(report, {
    surface: "download",
    title: download.filename,
    url: download.finalUrl || download.url || "",
    links: [download.finalUrl || download.url || ""],
    attachments: [download.filename],
    text: `${download.mime || ""} ${download.danger || ""}`
  }));
});
