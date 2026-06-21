(function attachRiskEngine(root) {
  const FALLBACK_BASE = "https://veyra.local/";
  const CURRENT_BASE = root.location && root.location.href ? root.location.href : FALLBACK_BASE;

  const BRAND_WORDS = ["google", "microsoft", "apple", "paypal", "amazon", "chase", "wellsfargo", "docusign", "dropbox", "onedrive", "office", "github", "netflix", "adobe", "bankofamerica"];
  const TRUSTED_BRAND_DOMAINS = {
    google: ["google.com", "gmail.com", "googleworkspace.com"],
    microsoft: ["microsoft.com", "office.com", "live.com", "outlook.com"],
    office: ["microsoft.com", "office.com", "office365.com"],
    apple: ["apple.com", "icloud.com"],
    paypal: ["paypal.com"],
    amazon: ["amazon.com", "amazonaws.com"],
    chase: ["chase.com"],
    wellsfargo: ["wellsfargo.com"],
    docusign: ["docusign.com"],
    dropbox: ["dropbox.com"],
    onedrive: ["onedrive.live.com", "microsoft.com"],
    github: ["github.com"],
    netflix: ["netflix.com"],
    adobe: ["adobe.com"],
    bankofamerica: ["bankofamerica.com", "bofa.com"]
  };

  const CHARACTER_SKELETON = {
    "0": "o", "ο": "o", "о": "o", "օ": "o",
    "1": "l", "i": "l", "ı": "l", "і": "l", "í": "l", "ì": "l", "ï": "l", "|": "l", "!": "l",
    "3": "e", "е": "e", "€": "e",
    "4": "a", "@": "a", "а": "a",
    "5": "s", "$": "s", "ѕ": "s",
    "7": "t",
    "8": "b",
    "с": "c", "¢": "c",
    "р": "p",
    "х": "x",
    "у": "y",
    "ԁ": "d",
    "ԛ": "q",
    "ɡ": "g", "9": "g"
  };

  const REPORTABLE_CONFUSABLES = {
    "0": "o", "ο": "o", "о": "o", "օ": "o",
    "1": "l", "ı": "l", "і": "l", "í": "l", "ì": "l", "ï": "l", "|": "l", "!": "l",
    "3": "e", "е": "e", "€": "e",
    "4": "a", "@": "a", "а": "a",
    "5": "s", "$": "s", "ѕ": "s",
    "7": "t",
    "8": "b",
    "с": "c", "¢": "c",
    "р": "p",
    "х": "x",
    "у": "y",
    "ԁ": "d",
    "ԛ": "q",
    "ɡ": "g", "9": "g"
  };

  const LOOKALIKE_PATTERNS = [
    { from: "rn", to: "m", label: "rn can read as m" },
    { from: "ri", to: "n", label: "ri can read as n" },
    { from: "vv", to: "w", label: "vv can read as w" },
    { from: "cl", to: "d", label: "cl can read as d" },
    { from: "1", to: "l", label: "1 can read as l" },
    { from: "0", to: "o", label: "0 can read as o" }
  ];

  const SEMANTIC_INTENTS = {
    account: /\b(account|password|passcode|login|sign in|mfa|2fa|otp|verify|unlock|security alert|mailbox)\b/i,
    payment: /\b(invoice|payment|wire|ach|bank|billing|payroll|vendor|gift card|routing)\b/i,
    document: /\b(document|attachment|file|download|shared|statement|pdf|spreadsheet|contract)\b/i,
    permission: /\b(authorize|grant|allow|permission|oauth|consent|access to files|access to email)\b/i,
    urgency: /\b(urgent|immediately|today|final notice|last warning|expires|suspended|within 24 hours)\b/i
  };

  const EXECUTABLE_EXTENSIONS = [".exe", ".scr", ".bat", ".cmd", ".js", ".vbs", ".ps1", ".msi", ".jar", ".iso", ".img", ".lnk", ".hta"];
  const ACTIVE_DOCUMENT_EXTENSIONS = [".docm", ".xlsm", ".pptm", ".html", ".htm", ".svg"];

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function safeUrl(value) {
    try {
      return new URL(String(value || ""), CURRENT_BASE);
    } catch (_error) {
      return null;
    }
  }

  function normalizeHost(host) {
    return String(host || "").replace(/^www\./, "").toLowerCase();
  }

  function rootDomain(host) {
    const normalized = normalizeHost(host);
    const parts = normalized.split(".").filter(Boolean);
    if (parts.length <= 2) return normalized;
    return parts.slice(-2).join(".");
  }

  function getHost(value) {
    const url = safeUrl(value);
    return url ? normalizeHost(url.hostname) : "";
  }

  function parseEmail(value) {
    const raw = String(value || "");
    const address = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || "";
    const host = address.split("@")[1] || "";
    const display = normalizeText(raw.replace(/<[^>]+>/g, "").replace(address, ""));
    return { address, display, host: normalizeHost(host), root: rootDomain(host), local: address.split("@")[0] || "" };
  }

  function scriptsFor(value) {
    const scripts = new Set();
    for (const char of String(value || "")) {
      if (/[a-z]/i.test(char)) scripts.add("latin");
      else if (/[\u0400-\u04ff]/.test(char)) scripts.add("cyrillic");
      else if (/[\u0370-\u03ff]/.test(char)) scripts.add("greek");
      else if (/[\u0530-\u058f]/.test(char)) scripts.add("armenian");
    }
    return [...scripts];
  }

  function skeleton(value) {
    let output = String(value || "").toLowerCase().normalize("NFKC");
    output = [...output].map((char) => CHARACTER_SKELETON[char] || char).join("");
    LOOKALIKE_PATTERNS.forEach((pattern) => {
      output = output.split(pattern.from.toLowerCase()).join(pattern.to);
    });
    return output.replace(/[^a-z0-9]/g, "");
  }

  function editDistance(a, b) {
    const rows = Array.from({ length: a.length + 1 }, () => []);
    for (let i = 0; i <= a.length; i += 1) rows[i][0] = i;
    for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        rows[i][j] = Math.min(
          rows[i - 1][j] + 1,
          rows[i][j - 1] + 1,
          rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
    }
    return rows[a.length][b.length];
  }

  function brandForHost(host) {
    const normalizedHost = normalizeHost(host);
    const root = rootDomain(normalizedHost);
    const labels = normalizedHost.split(".").filter(Boolean);

    for (const brand of BRAND_WORDS) {
      const official = TRUSTED_BRAND_DOMAINS[brand] || [];
      if (official.some((domain) => root === domain || normalizedHost.endsWith(`.${domain}`))) {
        return { brand, official: true };
      }

      if (labels.some((label) => label === brand || label.includes(brand))) {
        return { brand, official: false, reason: "brand appears in an unofficial domain" };
      }

      if (labels.some((label) => {
        const labelSkeleton = skeleton(label);
        return labelSkeleton.length >= 4 && (labelSkeleton === brand || editDistance(labelSkeleton, brand) <= 1);
      })) {
        return { brand, official: false, lookalike: true, reason: "domain skeleton is visually close to a trusted brand" };
      }
    }

    return null;
  }

  function severityFromPoints(points) {
    if (points >= 22) return "high";
    if (points >= 12) return "medium";
    return "low";
  }

  function addFinding(findings, finding) {
    const normalized = {
      id: finding.id,
      severity: finding.severity || severityFromPoints(finding.points || 8),
      points: finding.points || 8,
      category: finding.category || "Evidence",
      where: finding.where || "Available data",
      detail: finding.detail || "Veyra found a risk signal.",
      advice: finding.advice || "Verify before taking sensitive action.",
      source: finding.source || "Veyra feature model"
    };

    const key = `${normalized.id}|${normalized.where}|${normalized.detail}`;
    if (!findings.some((existing) => `${existing.id}|${existing.where}|${existing.detail}` === key)) {
      findings.push(normalized);
    }
  }

  function linkParts(link) {
    if (typeof link === "string") return { href: link, text: "" };
    return {
      href: link && (link.href || link.url) ? String(link.href || link.url) : "",
      text: link && link.text ? String(link.text) : ""
    };
  }

  function uniqueCount(values) {
    return new Set(values.filter(Boolean)).size;
  }

  function detectConfusables(value) {
    const raw = String(value || "");
    const lower = raw.toLowerCase();
    const hits = [];
    LOOKALIKE_PATTERNS.forEach((pattern) => {
      if (lower.includes(pattern.from.toLowerCase())) hits.push(pattern.label);
    });
    [...raw].forEach((char) => {
      if (REPORTABLE_CONFUSABLES[char]) hits.push(`${char} can read as ${REPORTABLE_CONFUSABLES[char]}`);
    });
    return [...new Set(hits)];
  }

  function extractIntent(text) {
    const normalized = normalizeText(text);
    return Object.fromEntries(Object.entries(SEMANTIC_INTENTS).map(([name, regex]) => [name, regex.test(normalized)]));
  }

  function intentNames(intent) {
    return Object.entries(intent).filter(([, present]) => present).map(([name]) => name);
  }

  function extractUrlFeatures(value) {
    const url = safeUrl(value);
    if (!url) {
      return {
        valid: false,
        urlLength: String(value || "").length,
        hasHttps: false,
        hasPunycode: /xn--/i.test(String(value || "")),
        mixedScript: scriptsFor(value).length > 1,
        brandImpersonation: false,
        confusableHits: detectConfusables(value)
      };
    }

    const host = normalizeHost(url.hostname);
    const brand = brandForHost(host);
    return {
      valid: true,
      urlLength: url.href.length,
      depth: url.pathname.split("/").filter(Boolean).length,
      hasHttps: url.protocol === "https:",
      hasAtSign: Boolean(url.username || url.password || /@/.test(url.href.replace(`${url.protocol}//`, "").split(/[/?#]/)[0])),
      hasPunycode: host.includes("xn--"),
      mixedScript: host.split(".").some((label) => scriptsFor(label).length > 1),
      brandImpersonation: Boolean(brand && !brand.official),
      brand: brand?.brand || "",
      confusableHits: detectConfusables(host)
    };
  }

  function extractTextFeatures(text) {
    const normalized = normalizeText(text);
    const words = normalized ? normalized.split(/\s+/) : [];
    const intent = extractIntent(normalized);
    return {
      charCount: normalized.length,
      wordCount: words.length,
      intent,
      intentNames: intentNames(intent),
      asksForAction: /\b(click|open|download|reply|call|sign in|login|verify|confirm|update|send|pay|approve)\b/i.test(normalized)
    };
  }

  function extractSurfaceFeatures(input) {
    const links = Array.isArray(input.links) ? input.links.map(linkParts).filter((link) => link.href) : [];
    const hosts = links.map((link) => getHost(link.href)).filter(Boolean);
    const urlFeatures = extractUrlFeatures(input.url || "");
    const textFeatures = extractTextFeatures(input.text || "");
    const sender = parseEmail(input.sender || "");
    const recipients = Array.isArray(input.recipients) ? input.recipients.map(parseEmail) : [];
    return {
      url: urlFeatures,
      text: textFeatures,
      email: {
        senderHost: sender.host,
        senderRoot: sender.root,
        senderSkeleton: skeleton(sender.host || sender.address || input.sender || ""),
        senderConfusables: detectConfusables(`${sender.local} ${sender.host}`),
        recipientCount: recipients.length,
        subjectIntent: extractIntent(input.title || input.subject || ""),
        bodyIntent: textFeatures.intent
      },
      links: {
        count: links.length,
        uniqueHostCount: uniqueCount(hosts.map(rootDomain)),
        externalHostCount: Number(input.externalHostCount || 0),
        confusableHostCount: links.filter((link) => extractUrlFeatures(link.href).confusableHits.length).length,
        brandImpersonationCount: links.filter((link) => extractUrlFeatures(link.href).brandImpersonation).length,
        punycodeCount: links.filter((link) => extractUrlFeatures(link.href).hasPunycode).length,
        mixedScriptCount: links.filter((link) => extractUrlFeatures(link.href).mixedScript).length
      },
      attachments: {
        count: Array.isArray(input.attachments) ? input.attachments.length : 0,
        executableCount: (input.attachments || []).filter((name) => EXECUTABLE_EXTENSIONS.some((ext) => String(name).toLowerCase().endsWith(ext))).length,
        activeDocumentCount: (input.attachments || []).filter((name) => ACTIVE_DOCUMENT_EXTENSIONS.some((ext) => String(name).toLowerCase().endsWith(ext))).length
      },
      page: {
        formCount: Array.isArray(input.forms) ? input.forms.length : 0,
        passwordFormCount: (input.forms || []).filter((form) => form.hasPassword).length,
        scriptHostCount: Number(input.scriptHostCount || 0),
        iframeCount: Number(input.iframeCount || 0)
      }
    };
  }

  function analyzeVisualIdentity(input, findings) {
    const sender = parseEmail(input.sender || "");
    const isEmail = input.surface === "email" || input.surface === "email-preview";
    const values = [
      { label: "sender", value: `${sender.local} ${sender.host}` },
      { label: "page URL", value: isEmail ? "" : getHost(input.url || "") },
      ...(input.links || []).map((link) => ({ label: "linked domain", value: getHost(linkParts(link).href) })),
      ...(input.attachments || []).map((name) => ({ label: "attachment name", value: name }))
    ];

    values.forEach((item) => {
      const confusables = detectConfusables(item.value);
      if (confusables.length) {
        addFinding(findings, {
          id: "visual-confusable",
          severity: item.label === "sender" || item.label === "linked domain" ? "high" : "medium",
          points: item.label === "sender" || item.label === "linked domain" ? 24 : 14,
          category: "Exact visual evidence",
          where: item.label,
          detail: `Looks visually ambiguous: ${confusables.slice(0, 3).join(", ")}.`,
          advice: "Read the address character by character before trusting it.",
          source: "Veyra confusable-character detector"
        });
      }
    });

    const hosts = [isEmail ? "" : getHost(input.url || ""), ...(input.links || []).map((link) => getHost(linkParts(link).href))].filter(Boolean);
    hosts.forEach((host) => {
      if (host.includes("xn--")) {
        addFinding(findings, {
          id: "punycode-domain",
          severity: "high",
          points: 25,
          category: "Exact visual evidence",
          where: host,
          detail: "The domain uses punycode, which can encode lookalike characters.",
          advice: "Use a known bookmark or type the official domain manually.",
          source: "Veyra homograph detector"
        });
      }

      if (host.split(".").some((label) => scriptsFor(label).length > 1)) {
        addFinding(findings, {
          id: "mixed-script-domain",
          severity: "high",
          points: 24,
          category: "Exact visual evidence",
          where: host,
          detail: "The domain mixes character scripts, a common homograph impersonation pattern.",
          advice: "Do not enter sensitive information on this domain.",
          source: "Veyra mixed-script detector"
        });
      }

      const brand = brandForHost(host);
      if (brand && !brand.official) {
        addFinding(findings, {
          id: brand.lookalike ? "brand-lookalike-skeleton" : "brand-name-unofficial-domain",
          severity: "high",
          points: brand.lookalike ? 27 : 20,
          category: "Exact visual evidence",
          where: host,
          detail: `The domain appears close to ${brand.brand}, but it is not an official ${brand.brand} domain.`,
          advice: "Navigate to the official site yourself instead of using this destination.",
          source: "Veyra domain skeleton detector"
        });
      }
    });
  }

  function analyzeEmailIdentity(input, findings) {
    const sender = parseEmail(input.sender || "");
    const replyTo = parseEmail(input.replyTo || "");
    const returnPath = parseEmail(input.returnPath || "");
    const displayText = `${sender.display} ${input.senderDisplay || ""}`;

    if (!sender.address && !sender.host && !displayText) return;

    BRAND_WORDS.forEach((brand) => {
      const officialDomains = TRUSTED_BRAND_DOMAINS[brand] || [];
      const displayMentionsBrand = new RegExp(`\\b${brand.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(displayText);
      const senderIsOfficial = officialDomains.some((domain) => sender.root === domain || sender.host.endsWith(`.${domain}`));
      if (displayMentionsBrand && sender.host && !senderIsOfficial) {
        addFinding(findings, {
          id: "display-name-domain-mismatch",
          severity: "high",
          points: 24,
          category: "Exact sender evidence",
          where: sender.host,
          detail: `The display name references ${brand}, but the visible sender domain is different.`,
          advice: "Trust the email address and domain more than the display name.",
          source: "Veyra sender identity feature"
        });
      }
    });

    if (replyTo.host && sender.host && replyTo.root !== sender.root) {
      addFinding(findings, {
        id: "reply-to-domain-mismatch",
        severity: "medium",
        points: 16,
        category: "Exact sender evidence",
        where: `${sender.host} -> ${replyTo.host}`,
        detail: "The Reply-To domain differs from the visible sender domain.",
        advice: "Do not reply with sensitive information until verified elsewhere.",
        source: "Veyra sender identity feature"
      });
    }

    if (returnPath.host && sender.host && returnPath.root !== sender.root) {
      addFinding(findings, {
        id: "return-path-domain-mismatch",
        severity: "medium",
        points: 16,
        category: "Exact sender evidence",
        where: `${sender.host} -> ${returnPath.host}`,
        detail: "The Return-Path domain differs from the visible sender domain.",
        advice: "Raw Gmail headers or an email API can confirm authentication alignment.",
        source: "Veyra sender identity feature"
      });
    }

    const auth = input.authentication || {};
    ["spf", "dkim", "dmarc"].forEach((key) => {
      const value = String(auth[key] || "").toLowerCase();
      if (["fail", "softfail", "none", "neutral", "temperror", "permerror"].includes(value)) {
        addFinding(findings, {
          id: `${key}-alignment-missing`,
          severity: key === "dmarc" ? "high" : "medium",
          points: key === "dmarc" ? 22 : 14,
          category: "Exact sender evidence",
          where: key.toUpperCase(),
          detail: `${key.toUpperCase()} did not pass or was unavailable in the supplied data.`,
          advice: "Treat sender identity as weaker without aligned authentication.",
          source: "Veyra sender identity feature"
        });
      }
    });
  }

  function analyzeSemanticMismatch(input, findings) {
    const titleIntent = extractIntent(input.title || input.subject || "");
    const bodyIntent = extractIntent(input.text || "");
    const titleNames = intentNames(titleIntent);
    const bodyNames = intentNames(bodyIntent);
    const sender = parseEmail(input.sender || "");
    const linkCount = Array.isArray(input.links) ? input.links.length : 0;
    const attachmentCount = Array.isArray(input.attachments) ? input.attachments.length : 0;

    if (titleNames.length && bodyNames.length && !titleNames.some((name) => bodyIntent[name])) {
      addFinding(findings, {
        id: "header-content-intent-mismatch",
        severity: "medium",
        points: 17,
        category: "AI semantic evidence",
        where: input.title || "Subject/header",
        detail: `The subject/header looks like ${titleNames.join(", ")}, while the body reads like ${bodyNames.join(", ")}.`,
        advice: "Confirm the request outside the email if the topic shift is unexpected.",
        source: "Veyra local semantic feature model"
      });
    }

    if ((bodyIntent.account || bodyIntent.payment || bodyIntent.permission) && (linkCount || attachmentCount) && !sender.host) {
      addFinding(findings, {
        id: "sensitive-action-with-weak-sender",
        severity: "medium",
        points: 16,
        category: "AI semantic evidence",
        where: "Message body",
        detail: "The message asks for a sensitive action but the sender identity is incomplete in the visible Gmail data.",
        advice: "Open sender details or verify through a trusted channel before continuing.",
        source: "Veyra local semantic feature model"
      });
    }

    if (bodyIntent.urgency && (bodyIntent.account || bodyIntent.payment || bodyIntent.permission)) {
      addFinding(findings, {
        id: "urgent-sensitive-intent",
        severity: "medium",
        points: 14,
        category: "AI semantic evidence",
        where: "Message body",
        detail: "The content combines urgency with account, payment, or permission intent.",
        advice: "Treat the request as untrusted until independently verified.",
        source: "Veyra local semantic feature model"
      });
    }
  }

  function analyzeObjectContext(input, findings) {
    const attachments = Array.isArray(input.attachments) ? input.attachments.map(String) : [];
    attachments.forEach((name) => {
      const lower = name.toLowerCase();
      if (EXECUTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        addFinding(findings, {
          id: "executable-object",
          severity: "high",
          points: 24,
          category: "Exact object evidence",
          where: name,
          detail: "The file type can execute code.",
          advice: "Do not open unless it was expected and verified.",
          source: "Veyra attachment feature model"
        });
      } else if (ACTIVE_DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        addFinding(findings, {
          id: "active-document-object",
          severity: "medium",
          points: 13,
          category: "Exact object evidence",
          where: name,
          detail: "The file type can contain active content or embedded scripts.",
          advice: "Preview in a protected viewer before interacting.",
          source: "Veyra attachment feature model"
        });
      }
    });

    const forms = Array.isArray(input.forms) ? input.forms : [];
    if (forms.some((form) => form.hasPassword) && safeUrl(input.url || "")?.protocol !== "https:") {
      addFinding(findings, {
        id: "password-form-without-https",
        severity: "high",
        points: 25,
        category: "Exact object evidence",
        where: getHost(input.url || "") || "Current page",
        detail: "A password form is present without HTTPS.",
        advice: "Do not submit credentials on this page.",
        source: "Veyra browser feature model"
      });
    }
  }

  function scoreFindings(findings) {
    const raw = findings.reduce((sum, finding) => sum + (finding.points || 0), 0);
    const highCount = findings.filter((finding) => finding.severity === "high").length;
    const exactStrongSignals = findings.filter((finding) => finding.category.startsWith("Exact") && finding.severity === "high").length;
    const diversityBonus = new Set(findings.map((finding) => finding.category)).size * 2;
    return Math.min(100, raw + diversityBonus + Math.max(0, highCount - 1) * 5 + exactStrongSignals * 3);
  }

  function levelForScore(score) {
    if (score >= 55) return "dangerous";
    if (score >= 25) return "moderate";
    return "safe";
  }

  function recommendationFor(level) {
    if (level === "dangerous") return "Do not proceed. Use a known trusted site or contact the sender through a separate channel.";
    if (level === "moderate") return "Proceed only if you expected this and can verify the sender, domain, and requested action.";
    return "No strong evidence was found in the available data. Stay cautious with sensitive information.";
  }

  function analyzeSurface(input) {
    const findings = [];
    const payload = input || {};
    analyzeEmailIdentity(payload, findings);
    analyzeVisualIdentity(payload, findings);
    analyzeSemanticMismatch(payload, findings);
    analyzeObjectContext(payload, findings);

    const score = scoreFindings(findings);
    const level = levelForScore(score);
    return {
      id: payload.id || `${Date.now()}`,
      surface: payload.surface || "website",
      title: payload.title || "Untitled scan",
      url: payload.url || "",
      score,
      level,
      features: extractSurfaceFeatures(payload),
      findings: findings.sort((a, b) => (b.points || 0) - (a.points || 0)),
      recommendation: recommendationFor(level),
      confirmationKeyword: level === "safe" ? "" : "I UNDERSTAND",
      model: "Veyra hybrid AI/ML feature model v0.5",
      scannedAt: new Date().toISOString()
    };
  }

  root.VeyraRiskEngine = {
    analyzeSurface,
    normalizeText,
    levelForScore,
    getHost,
    rootDomain,
    extractSurfaceFeatures,
    extractUrlFeatures,
    skeleton,
    detectConfusables
  };
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : window);
