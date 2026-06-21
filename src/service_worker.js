importScripts("risk_engine.js");

const ACTIVITY_KEY = "veyraRecentActivity";
const FEEDBACK_KEY = "veyraFeedback";
const LOCAL_MODEL_ENDPOINT = "http://127.0.0.1:8765/score";
const LOCAL_AI_ENDPOINT = "http://127.0.0.1:8766/analyze";
const LOCAL_SPOOF_MODEL_ENDPOINT = "http://127.0.0.1:8767/score";
const OPENAI_CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const TOPIC_CACHE_TTL_MS = 10 * 60 * 1000;
const SAFE_HOSTS_KEY = "veyraSafeHosts";
const SENDER_MEMORY_KEY = "veyraSenderMemory";
const SENDER_PROFILE_KEY = "veyraSenderProfiles";
const SAFE_HOST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SENDER_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const topicCache = new Map();

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

async function getSettings() {
  const data = await chrome.storage.local.get({
    veyraSettings: {
      protectionEnabled: true,
      confirmationKeyword: "I UNDERSTAND",
      adSupportedMode: false,
      localModelEndpoint: LOCAL_MODEL_ENDPOINT,
      openaiApiKey: "",
      openaiModel: "gpt-4.1-mini"
    }
  });
  return data.veyraSettings || {};
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
  return report.findings.some((finding) => ["Exact visual evidence", "Exact object evidence", "ML URL model", "ML spoof model"].includes(finding.category));
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
  const senderFindings = report.findings.filter((finding) => finding.category === "Exact sender evidence");
  const linkAttachmentFindings = report.findings.filter((finding) => ["Exact visual evidence", "Exact object evidence", "ML URL model", "ML spoof model"].includes(finding.category));
  const comprehensionFindings = report.findings.filter((finding) => ["AI semantic evidence", "AI model"].includes(finding.category));

  return {
    name: "Veyra hybrid AI/ML email framework",
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
      name: "Veyra hybrid AI/ML email framework",
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

function collectSpoofInputs(payload) {
  const inputs = new Set();
  const sender = senderKeyFor(payload?.sender || "");
  if (sender) inputs.add(sender);

  (payload?.links || []).map(urlFromLink).forEach((url) => {
    if (!url) return;
    inputs.add(url);
    const host = hostFor(url);
    if (host && host !== "Unknown URL") inputs.add(host);
  });

  return [...inputs].filter(Boolean).slice(0, 40);
}

async function fetchLocalSpoofScores(inputs) {
  if (!inputs.length) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 950);
  try {
    const response = await fetch(LOCAL_SPOOF_MODEL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs }),
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

function flagSummary(flags) {
  if (!Array.isArray(flags) || !flags.length) return "No character-level flags returned.";
  return flags.slice(0, 4).map((flag) => {
    const text = String(flag.text || "").trim() || "invisible";
    return `${text} at ${flag.start}-${flag.end} (${flag.reason || "suspicious"})`;
  }).join("; ");
}

function addSpoofModelFinding(report, result) {
  const probability = Number(result.spoof_probability || 0);
  const predictedSpoof = result.label === 1 || result.label === "1" || String(result.label_text || "").toLowerCase() === "spoof";
  if (probability < 0.55 && !predictedSpoof) return;

  const points = probability >= 0.82 || predictedSpoof ? 24 : 15;
  const input = String(result.input || "Email identity");
  addServiceFinding(report, {
    id: "visual-spoof-ml-score",
    severity: points >= 22 ? "high" : "medium",
    points,
    category: "ML spoof model",
    where: input.slice(0, 120),
    detail: `Visual spoof ML model estimated ${Math.round(probability * 100)}% spoof probability. ${flagSummary(result.flags)}`,
    advice: "Check the sender and link domains character by character before trusting this message.",
    source: "Local Veyra visual spoof detector"
  });
}

async function enrichReportWithSpoofModel(report, payload) {
  if (!isEmailSurface(payload?.surface)) return report;

  const inputs = collectSpoofInputs(payload);
  const modelResponse = await fetchLocalSpoofScores(inputs);
  if (!modelResponse || modelResponse.status === "unavailable") return report;

  report.spoofMl = {
    status: modelResponse.status || "ok",
    model: modelResponse.model || "local-visual-spoof-model",
    results: (modelResponse.results || []).slice(0, 12)
  };

  (modelResponse.results || []).forEach((result) => addSpoofModelFinding(report, result));
  recomputeReportRisk(report);
  report.model = `${report.model} + local visual spoof ML model`;
  return report;
}

function topicCacheKey(payload) {
  return `${senderKeyFor(payload?.sender || "")}|${String(payload?.subject || payload?.title || "").slice(0, 180)}`;
}

function getCachedTopic(key) {
  const entry = topicCache.get(key);
  if (!entry) return null;
  if (Date.now() - Number(entry.createdAt || 0) > TOPIC_CACHE_TTL_MS) {
    topicCache.delete(key);
    return null;
  }
  return entry;
}

function parseOpenAiJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_innerError) {
      return null;
    }
  }
}

function outputTextFromOpenAi(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const chunks = [];
  (data?.output || []).forEach((item) => {
    (item.content || []).forEach((content) => {
      if (typeof content.text === "string") chunks.push(content.text);
    });
  });
  return chunks.join("\n");
}

async function callOpenAiTopicModel({ apiKey, model, kind, text }) {
  const trimmed = String(text || "").replace(/\s+/g, " ").trim().slice(0, 6000);
  if (!apiKey || !trimmed) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(OPENAI_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model || "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: "You extract email topics for a security browser extension. Return only compact JSON."
          },
          {
            role: "user",
            content: `Analyze this ${kind}. Return JSON with keys topic, intent, sensitive_action, confidence. Text: ${trimmed}`
          }
        ],
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || outputTextFromOpenAi(data);
    return parseOpenAiJson(content) || { error: "Could not parse OpenAI topic JSON" };
  } catch (error) {
    return { error: error?.name === "AbortError" ? "timeout" : String(error?.message || error) };
  } finally {
    clearTimeout(timeout);
  }
}

function compareTopics(headerTopic, bodyTopic) {
  const header = String(headerTopic?.topic || "").toLowerCase();
  const body = String(bodyTopic?.topic || "").toLowerCase();
  const headerIntent = String(headerTopic?.intent || "").toLowerCase();
  const bodyIntent = String(bodyTopic?.intent || "").toLowerCase();
  const sameTopic = Boolean(header && body && (header === body || header.includes(body) || body.includes(header)));
  const sameIntent = Boolean(headerIntent && bodyIntent && (headerIntent === bodyIntent || headerIntent.includes(bodyIntent) || bodyIntent.includes(headerIntent)));
  const mismatch = Boolean(header && body && !sameTopic && !sameIntent);
  return {
    headerTopic,
    bodyTopic,
    match: !mismatch,
    mismatch,
    reason: mismatch
      ? `Header topic "${headerTopic.topic}" differs from body topic "${bodyTopic.topic}".`
      : "Header and body topics appear aligned."
  };
}

async function enrichReportWithOpenAiTopicCheck(report, payload) {
  if (payload?.surface !== "email") return report;
  const settings = await getSettings();
  const apiKey = String(settings.openaiApiKey || "").trim();
  if (!apiKey) {
    report.topicMatch = {
      status: "disabled",
      reason: "No OpenAI API key saved locally."
    };
    return report;
  }

  const key = topicCacheKey(payload);
  const cached = getCachedTopic(key);
  const headerText = `${payload.subject || payload.title || ""} ${payload.headerText || ""}`.trim();
  const bodyText = String(payload.text || "").replace(String(payload.headerText || ""), "").trim() || payload.text || "";
  const headerTopic = cached?.headerTopic || await callOpenAiTopicModel({
    apiKey,
    model: settings.openaiModel,
    kind: "email header and subject",
    text: headerText
  });
  if (!cached && headerTopic && !headerTopic.error) {
    topicCache.set(key, { headerTopic, createdAt: Date.now() });
  }

  const bodyTopic = await callOpenAiTopicModel({
    apiKey,
    model: settings.openaiModel,
    kind: "email body",
    text: bodyText
  });

  if (headerTopic?.error || bodyTopic?.error) {
    report.topicMatch = {
      status: "error",
      headerTopic,
      bodyTopic,
      reason: headerTopic?.error || bodyTopic?.error
    };
    return report;
  }

  const comparison = compareTopics(headerTopic, bodyTopic);
  report.topicMatch = {
    status: "ok",
    model: settings.openaiModel || "gpt-4.1-mini",
    ...comparison
  };

  if (comparison.mismatch) {
    addServiceFinding(report, {
      id: "openai-header-body-topic-mismatch",
      severity: "medium",
      points: 18,
      category: "OpenAI topic model",
      where: payload.subject || payload.title || "Email topic",
      detail: comparison.reason,
      advice: "Treat this email as suspicious until the sender confirms the request through a trusted channel.",
      source: "OpenAI topic comparison"
    });
    recomputeReportRisk(report);
  }

  report.model = `${report.model} + OpenAI header/body topic check`;
  return report;
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
  const exactStrongSignals = report.findings.filter((finding) => String(finding.category || "").startsWith("Exact") && finding.severity === "high").length;
  const diversityBonus = new Set(report.findings.map((finding) => finding.category)).size * 2;
  report.score = Math.min(100, raw + diversityBonus + Math.max(0, highCount - 1) * 5 + exactStrongSignals * 3);
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
  const isEmail = isEmailSurface(payload?.surface);
  return {
    surface: payload?.surface || report.surface,
    title: String(payload?.title || report.title || "").slice(0, 160),
    subject: String(payload?.subject || payload?.title || report.title || "").slice(0, 240),
    text: isEmail ? String(payload?.text || "").slice(0, 12000) : "",
    sender: isEmail ? String(payload?.sender || "").slice(0, 240) : "",
    recipients: isEmail && Array.isArray(payload?.recipients) ? payload.recipients.slice(0, 20) : [],
    links: Array.isArray(payload?.links) ? payload.links.slice(0, 30) : [],
    attachments: Array.isArray(payload?.attachments) ? payload.attachments.slice(0, 30) : [],
    host: hostFor(payload?.url || report.url || ""),
    features: report.features || self.VeyraRiskEngine.extractSurfaceFeatures(payload || {}),
    findingIds: report.findings.map((finding) => finding.id).slice(0, 20),
    findingCategories: report.findings.map((finding) => finding.category).slice(0, 20)
  };
}

async function fetchLocalAiAnalysis(payload, report) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(LOCAL_AI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(redactedPayloadForAi(payload, report)),
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
    : "Veyra did not find strong identity, visual, or AI/ML risk evidence in the available data.";

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
    const senderKey = senderKeyFor(payload.sender);
    const senderMemory = await getSenderMemory();
    const senderMemoryEntry = senderKey ? senderMemory[senderKey] : null;

    if (isFreshTrustedSender(senderMemoryEntry) && !collectSpoofInputs(payload).some((input) => /^https?:\/\//i.test(input))) {
      return buildKnownSenderPassReport(payload, senderMemoryEntry);
    }

    const report = self.VeyraRiskEngine.analyzeSurface(payload);
    await enrichReportWithLocalModel(report, payload, payload.url);
    await enrichReportWithSpoofModel(report, payload);
    await enrichReportWithOpenAiTopicCheck(report, payload);
    await enrichReportWithSenderAnomaly(report, payload, senderMemoryEntry);
    report.framework = frameworkForEmail(report, payload, senderMemoryEntry);
    await enrichReportWithAi(report, payload);
    if (!options.preview) await updateSenderMemory(report, payload);
    if (!options.preview) await updateSenderProfile(report, payload);
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
  chrome.storage.local.get({ veyraSettings: {} }).then(({ veyraSettings }) => chrome.storage.local.set({
    veyraSettings: {
      ...(veyraSettings || {}),
      protectionEnabled: true,
      confirmationKeyword: veyraSettings?.confirmationKeyword || "I UNDERSTAND",
      adSupportedMode: Boolean(veyraSettings?.adSupportedMode),
      localModelEndpoint: LOCAL_MODEL_ENDPOINT
    }
  }));
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
