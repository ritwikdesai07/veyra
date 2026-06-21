(function attachRiskEngine(root) {
  const FALLBACK_BASE = "https://veyra.local/";
  const CURRENT_BASE = root.location && root.location.href ? root.location.href : FALLBACK_BASE;

  const RISKY_TLDS = new Set(["zip", "mov", "cam", "click", "country", "gq", "ml", "tk", "top", "xyz", "work", "rest", "quest"]);
  const SHORTENERS = new Set(["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "rebrand.ly", "cutt.ly", "lnkd.in", "buff.ly"]);
  const REDIRECT_PARAMS = ["url", "u", "redirect", "redirect_uri", "return", "returnurl", "next", "dest", "destination", "continue", "target"];
  const BRAND_WORDS = ["google", "microsoft", "apple", "paypal", "amazon", "bank", "chase", "wellsfargo", "docusign", "dropbox", "onedrive", "office", "github", "netflix"];
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
    netflix: ["netflix.com"]
  };

  const EXECUTABLE_EXTENSIONS = [".exe", ".scr", ".bat", ".cmd", ".js", ".vbs", ".ps1", ".msi", ".jar", ".iso", ".img", ".lnk", ".hta"];
  const RISKY_ATTACHMENT_EXTENSIONS = [".html", ".htm", ".svg", ".zip", ".rar", ".7z", ".one"];
  const OFFICE_MACRO_EXTENSIONS = [".docm", ".xlsm", ".pptm"];
  const PAYMENT_FIELD_NAMES = /\b(card|cc|cvv|cvc|expiry|routing|account|iban|swift|payment|billing)\b/i;
  const SECRET_FIELD_NAMES = /\b(password|passcode|otp|mfa|2fa|secret|seed|private|recovery)\b/i;

  const CONTENT_RULES = [
    {
      id: "urgency-pressure",
      severity: "medium",
      points: 14,
      category: "Social engineering",
      where: "Urgency language",
      regex: /\b(urgent|immediately|right away|final notice|last warning|account suspended|password expires|verify now|act now|within 24 hours)\b/i,
      detail: "The message uses pressure language that is common in social engineering.",
      advice: "Slow down and verify the request outside this message.",
      source: "CISA social engineering guidance"
    },
    {
      id: "credential-request",
      severity: "high",
      points: 24,
      category: "Credential harvesting",
      where: "Credential request",
      regex: /\b(password|passcode|mfa code|2fa code|one-time code|otp|seed phrase|private key|login credentials|verify your account)\b/i,
      detail: "The content asks for, references, or steers the user toward sensitive credentials.",
      advice: "Do not enter secrets from a link in the message.",
      source: "MITRE T1598"
    },
    {
      id: "payment-fraud",
      severity: "high",
      points: 22,
      category: "Business email compromise",
      where: "Payment request",
      regex: /\b(wire transfer|gift card|routing number|bank account|ach|swift|invoice overdue|payment update|change bank details|payroll update)\b/i,
      detail: "The message contains payment or bank-change language often used in fraud.",
      advice: "Confirm money movement through a known phone number or internal system.",
      source: "CISA phishing guidance"
    },
    {
      id: "macro-lure",
      severity: "high",
      points: 24,
      category: "Attachment execution",
      where: "Macro or protected-document lure",
      regex: /\b(enable macros|enable editing|enable content|protected document|secure document|view encrypted document)\b/i,
      detail: "The content encourages enabling active document features.",
      advice: "Do not enable macros or active content unless the file is verified.",
      source: "MITRE T1566.001"
    },
    {
      id: "generic-action",
      severity: "medium",
      points: 12,
      category: "Social engineering",
      where: "Generic greeting plus action",
      regex: /\b(dear customer|sir\/madam|valued user|kindly)\b.{0,120}\b(login|verify|confirm|update|restore|unlock)\b/i,
      detail: "The message combines generic language with account-action wording.",
      advice: "Check whether this communication matches the sender's normal style.",
      source: "CISA phishing guidance"
    },
    {
      id: "oauth-consent",
      severity: "medium",
      points: 15,
      category: "Data access",
      where: "Authorization request",
      regex: /\b(authorize this app|grant access|oauth|consent screen|allow access to your files|allow access to your email)\b/i,
      detail: "The content asks the user to grant application access to private data.",
      advice: "Review the app publisher and scopes before approving access.",
      source: "MITRE T1566.003"
    },
    {
      id: "callback-phishing",
      severity: "medium",
      points: 14,
      category: "Callback phishing",
      where: "Phone plus urgent billing language",
      regex: /(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}).{0,180}\b(invoice|refund|subscription|charge|renewal|cancel)\b/i,
      detail: "The content combines a phone number with urgent billing language.",
      advice: "Use a known official support number instead of the number in the message.",
      source: "MITRE T1566.004"
    }
  ];

  const INTENT_RULES = [
    {
      id: "intent-credential-theft",
      label: "credential theft",
      weight: 26,
      regexes: [/\b(sign in|login|verify|confirm|unlock|restore|update)\b/i, /\b(password|mfa|2fa|otp|account|mailbox)\b/i]
    },
    {
      id: "intent-bec-payment",
      label: "business email compromise",
      weight: 25,
      regexes: [/\b(invoice|payment|wire|ach|payroll|bank|vendor)\b/i, /\b(change|update|overdue|urgent|today|immediately)\b/i]
    },
    {
      id: "intent-malware-delivery",
      label: "malware delivery",
      weight: 24,
      regexes: [/\b(download|open|view|enable|extract)\b/i, /\b(attachment|document|invoice|archive|protected|encrypted|macro|content)\b/i]
    },
    {
      id: "intent-data-access",
      label: "data access request",
      weight: 18,
      regexes: [/\b(grant|authorize|allow|consent|permission)\b/i, /\b(files|email|drive|calendar|contacts|oauth|app)\b/i]
    }
  ];

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

  function getTld(host) {
    const parts = normalizeHost(host).split(".");
    return parts.length > 1 ? parts[parts.length - 1] : "";
  }

  function getHost(value) {
    const url = safeUrl(value);
    return url ? normalizeHost(url.hostname) : "";
  }

  // Reduces a URL down to its scheme + host ("the first part of the URL"),
  // the same way an email sender address is reduced to its domain before
  // being checked. Path segments, query strings, and fragments are dropped
  // so the model and pattern checks compare apples to apples regardless of
  // whether the URL came from a website link or an email link.
  //
  // "Cut out the stuff after the numbers": within the path (kept only for
  // informational use, not for the canonical form below) any segment that
  // is purely numeric, or a long opaque token (hex/base64-ish IDs, session
  // tokens), is stripped — those are noise that don't change what site the
  // link points to.
  const NUMERIC_SEGMENT = /^\d+$/;
  const OPAQUE_TOKEN_SEGMENT = /^[a-z0-9_-]{20,}$/i;

  function stripNumericAndTokenSegments(pathname) {
    const segments = String(pathname || "").split("/").filter(Boolean);
    const kept = segments.filter((segment) => !NUMERIC_SEGMENT.test(segment) && !OPAQUE_TOKEN_SEGMENT.test(segment));
    return kept.length ? `/${kept.join("/")}` : "/";
  }

  function canonicalizeUrlForCheck(value) {
    const url = safeUrl(value);
    if (!url) return { href: "", host: "", root: "", cleanPath: "/" };
    const host = normalizeHost(url.hostname);
    return {
      // The canonical form used for ML scoring and domain-level comparisons:
      // scheme + host only, just like an email is reduced to its domain.
      href: `${url.protocol}//${host}`,
      host,
      root: rootDomain(host),
      // Kept separately (not part of href) in case path-based heuristics
      // need a cleaned path without numeric IDs/tokens/query strings.
      cleanPath: stripNumericAndTokenSegments(url.pathname)
    };
  }

  function parseEmail(value) {
    const raw = String(value || "");
    const emailMatch = raw.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i);
    const addressMatch = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const address = addressMatch ? addressMatch[0].toLowerCase() : "";
    const host = emailMatch ? normalizeHost(emailMatch[1]) : "";
    const display = normalizeText(raw.replace(/<[^>]+>/g, "").replace(address, ""));
    return { address, display, host, root: rootDomain(host) };
  }

  function canonicalBrandLabel(value) {
    const cleaned = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return cleaned.replace(/0/g, "o").replace(/1/g, "l").replace(/3/g, "e").replace(/5/g, "s").replace(/rn/g, "m");
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
    for (const brand of BRAND_WORDS) {
      const official = TRUSTED_BRAND_DOMAINS[brand] || [];
      if (official.some((domain) => root === domain || normalizedHost.endsWith(`.${domain}`))) {
        return { brand, official: true };
      }
      if (normalizedHost.includes(brand)) {
        return { brand, official: false };
      }
      const labels = normalizedHost.split(".");
      if (labels.some((label) => {
        const canonical = canonicalBrandLabel(label);
        return canonical.length >= 5 && editDistance(canonical, brand) <= 1;
      })) {
        return { brand, official: false, lookalike: true };
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
      category: finding.category,
      where: finding.where,
      detail: finding.detail,
      advice: finding.advice,
      source: finding.source || "Veyra heuristic"
    };

    const key = `${normalized.id}|${normalized.where}|${normalized.detail}`;
    if (findings.some((existing) => `${existing.id}|${existing.where}|${existing.detail}` === key)) return;
    findings.push(normalized);
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

  function extractUrlFeatures(value) {
    const url = safeUrl(value);
    if (!url) {
      return {
        valid: false,
        urlLength: String(value || "").length,
        depth: 0,
        hasHttps: false,
        hasAtSign: /@/.test(String(value || "")),
        isIpHost: false,
        isShortener: false,
        riskyTld: false,
        hasPunycode: false,
        brandImpersonation: false,
        redirectParamCount: 0
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
      isIpHost: /^\d{1,3}(\.\d{1,3}){3}$/.test(host),
      isShortener: SHORTENERS.has(host),
      riskyTld: RISKY_TLDS.has(getTld(host)),
      hasPunycode: host.includes("xn--"),
      brandImpersonation: Boolean(brand && !brand.official),
      redirectParamCount: REDIRECT_PARAMS.filter((param) => url.searchParams.has(param)).length
    };
  }

  function extractTextFeatures(text) {
    const normalized = normalizeText(text);
    const words = normalized ? normalized.split(/\s+/) : [];
    return {
      charCount: normalized.length,
      wordCount: words.length,
      urgencyHits: (normalized.match(/\b(urgent|immediately|final notice|last warning|expires|suspended|within 24 hours)\b/gi) || []).length,
      credentialHits: (normalized.match(/\b(password|mfa|2fa|otp|seed phrase|private key|login|verify your account)\b/gi) || []).length,
      paymentHits: (normalized.match(/\b(invoice|wire transfer|gift card|routing number|bank account|ach|swift|payroll)\b/gi) || []).length,
      attachmentLureHits: (normalized.match(/\b(enable macros|enable editing|protected document|download|open attachment)\b/gi) || []).length,
      phoneCount: (normalized.match(/\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || []).length
    };
  }

  function extractSurfaceFeatures(input) {
    const links = Array.isArray(input.links) ? input.links.map(linkParts).filter((link) => link.href) : [];
    const hosts = links.map((link) => getHost(link.href)).filter(Boolean);
    const urlFeatures = extractUrlFeatures(input.url || "");
    const textFeatures = extractTextFeatures(input.text || "");
    const forms = Array.isArray(input.forms) ? input.forms : [];
    const formFields = forms.flatMap((form) => form.inputNames || []);

    return {
      url: urlFeatures,
      text: textFeatures,
      links: {
        count: links.length,
        uniqueHostCount: uniqueCount(hosts.map(rootDomain)),
        externalHostCount: Number(input.externalHostCount || 0),
        redirectLikeCount: links.filter((link) => extractUrlFeatures(link.href).redirectParamCount > 0).length,
        shortenerCount: links.filter((link) => extractUrlFeatures(link.href).isShortener).length,
        brandImpersonationCount: links.filter((link) => extractUrlFeatures(link.href).brandImpersonation).length
      },
      forms: {
        count: forms.length,
        passwordFormCount: forms.filter((form) => form.hasPassword).length,
        paymentFieldCount: formFields.filter((name) => PAYMENT_FIELD_NAMES.test(name)).length,
        secretFieldCount: formFields.filter((name) => SECRET_FIELD_NAMES.test(name)).length,
        hiddenFieldCount: forms.reduce((sum, form) => sum + Number(form.hiddenCount || 0), 0)
      },
      attachments: {
        count: Array.isArray(input.attachments) ? input.attachments.length : 0,
        executableCount: (input.attachments || []).filter((name) => EXECUTABLE_EXTENSIONS.some((ext) => String(name).toLowerCase().endsWith(ext))).length,
        macroCount: (input.attachments || []).filter((name) => OFFICE_MACRO_EXTENSIONS.some((ext) => String(name).toLowerCase().endsWith(ext))).length,
        archiveCount: (input.attachments || []).filter((name) => /\.(zip|rar|7z|iso|img)$/i.test(String(name))).length
      },
      page: {
        scriptHostCount: Number(input.scriptHostCount || 0),
        iframeCount: Number(input.iframeCount || 0),
        loginKeywordPresent: /\b(sign in|login|password|account)\b/i.test(`${input.title || ""} ${String(input.text || "").slice(0, 2000)}`)
      }
    };
  }

  function extractVisibleHosts(text) {
    const matches = String(text || "").match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.)+[a-z]{2,}/gi) || [];
    return matches.map((match) => getHost(match.startsWith("http") ? match : `https://${match}`)).filter(Boolean);
  }

  function analyzeLinks(links, findings) {
    const seen = new Set();
    links.map(linkParts).filter((link) => link.href).slice(0, 120).forEach((link) => {
      const url = safeUrl(link.href);
      if (!url) {
        addFinding(findings, {
          id: "malformed-link",
          severity: "medium",
          points: 13,
          category: "Links",
          where: "Malformed link",
          detail: link.href.slice(0, 140),
          advice: "Avoid malformed or unreadable links.",
          source: "Google Safe Browsing URL checks"
        });
        return;
      }

      if (seen.has(url.href)) return;
      seen.add(url.href);
      const host = normalizeHost(url.hostname);
      const tld = getTld(host);
      const pathText = `${url.pathname} ${url.search}`.toLowerCase();

      if (url.protocol !== "https:" && url.protocol !== "mailto:" && url.protocol !== "tel:") {
        addFinding(findings, {
          id: "non-https-link",
          severity: "medium",
          points: 14,
          category: "Links",
          where: host || url.protocol,
          detail: "The link does not use HTTPS.",
          advice: "Do not enter credentials or personal data on this destination.",
          source: "Google Safe Browsing URL checks"
        });
      }

      if (url.username || url.password || /@/.test(url.href.replace(`${url.protocol}//`, "").split(/[/?#]/)[0])) {
        addFinding(findings, {
          id: "url-userinfo",
          severity: "high",
          points: 26,
          category: "URL spoofing",
          where: host,
          detail: "The URL uses an @ sign or credential-style prefix that can hide the real destination.",
          advice: "Do not trust the visible front of this URL. Navigate manually instead.",
          source: "URL spoofing pattern"
        });
      }

      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        addFinding(findings, {
          id: "ip-host",
          severity: "high",
          points: 25,
          category: "URL spoofing",
          where: host,
          detail: "The link uses a raw IP address instead of a recognizable domain.",
          advice: "Do not sign in through this link.",
          source: "MITRE T1566.002"
        });
      }

      if (host.includes("xn--")) {
        addFinding(findings, {
          id: "punycode-host",
          severity: "high",
          points: 25,
          category: "Brand impersonation",
          where: host,
          detail: "The domain uses punycode, which can be used for homograph impersonation.",
          advice: "Inspect the destination carefully or use a known bookmark.",
          source: "URL homograph spoofing pattern"
        });
      }

      if (SHORTENERS.has(host)) {
        addFinding(findings, {
          id: "shortened-link",
          severity: "medium",
          points: 13,
          category: "Links",
          where: host,
          detail: "The link is shortened and hides its final destination.",
          advice: "Expand or verify the destination before continuing.",
          source: "MITRE T1566.002"
        });
      }

      if (RISKY_TLDS.has(tld)) {
        addFinding(findings, {
          id: "risky-tld",
          severity: "medium",
          points: 12,
          category: "Domain reputation",
          where: host,
          detail: `The domain uses a higher-risk .${tld} ending.`,
          advice: "Verify the domain carefully before entering data.",
          source: "URL risk heuristic"
        });
      }

      const brand = brandForHost(host);
      if (brand && !brand.official) {
        addFinding(findings, {
          id: brand.lookalike ? "brand-lookalike-domain" : "brand-in-unofficial-domain",
          severity: "high",
          points: brand.lookalike ? 27 : 24,
          category: "Brand impersonation",
          where: host,
          detail: `The domain appears to imitate ${brand.brand} but is not an official ${brand.brand} domain.`,
          advice: "Navigate manually to the official service.",
          source: "MITRE T1566.002"
        });
      }

      const visibleHosts = extractVisibleHosts(link.text);
      visibleHosts.forEach((visibleHost) => {
        if (visibleHost && rootDomain(visibleHost) !== rootDomain(host)) {
          addFinding(findings, {
            id: "visible-link-mismatch",
            severity: "high",
            points: 27,
            category: "URL spoofing",
            where: `${visibleHost} -> ${host}`,
            detail: "The visible link text points to a different domain than the actual destination.",
            advice: "Do not click. Use the official website directly.",
            source: "MITRE T1566.002"
          });
        }
      });

      REDIRECT_PARAMS.forEach((param) => {
        const value = url.searchParams.get(param);
        const nested = value ? safeUrl(value) : null;
        if (nested && nested.hostname && rootDomain(nested.hostname) !== rootDomain(host)) {
          addFinding(findings, {
            id: "open-redirect-chain",
            severity: "medium",
            points: 16,
            category: "Redirect chain",
            where: host,
            detail: `The URL contains a redirect parameter to ${normalizeHost(nested.hostname)}.`,
            advice: "Be cautious with redirects that hide the final destination.",
            source: "URL redirect spoofing pattern"
          });
        }
      });

      if (host.split(".").length >= 5) {
        addFinding(findings, {
          id: "deep-subdomain",
          severity: "low",
          points: 7,
          category: "URL spoofing",
          where: host,
          detail: "The destination uses many subdomain levels, which can hide the registrable domain.",
          advice: "Read the domain from right to left and verify the registrable domain.",
          source: "URL spoofing pattern"
        });
      }

      if (pathText.length > 120 && /\b(login|verify|secure|account|password|invoice|payment)\b/.test(pathText)) {
        addFinding(findings, {
          id: "long-action-url",
          severity: "medium",
          points: 13,
          category: "URL spoofing",
          where: host,
          detail: "The link uses a long action-oriented path that can obscure tracking and redirects.",
          advice: "Avoid signing in from long unsolicited links.",
          source: "MITRE T1566.002"
        });
      }
    });
  }

  function analyzeAttachments(attachments, findings) {
    attachments.map(String).filter(Boolean).slice(0, 40).forEach((name) => {
      const lower = name.toLowerCase();
      if (/\.(pdf|docx|xlsx|pptx|jpg|png)\.(exe|scr|js|vbs|hta|lnk)$/i.test(lower)) {
        addFinding(findings, {
          id: "double-extension",
          severity: "high",
          points: 29,
          category: "Attachments",
          where: name,
          detail: "The filename uses a double extension to disguise executable content.",
          advice: "Do not open this attachment.",
          source: "MITRE T1566.001"
        });
      }

      if (EXECUTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        addFinding(findings, {
          id: "executable-attachment",
          severity: "high",
          points: 28,
          category: "Attachments",
          where: name,
          detail: "The file type can execute code on your device.",
          advice: "Do not open unless verified through a trusted channel.",
          source: "MITRE T1566.001"
        });
      }

      if (OFFICE_MACRO_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        addFinding(findings, {
          id: "macro-attachment",
          severity: "medium",
          points: 17,
          category: "Attachments",
          where: name,
          detail: "The Office file type may contain macros.",
          advice: "Open only in protected view and avoid enabling macros.",
          source: "MITRE T1566.001"
        });
      }

      if (RISKY_ATTACHMENT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        addFinding(findings, {
          id: "risky-attachment-container",
          severity: "medium",
          points: 13,
          category: "Attachments",
          where: name,
          detail: "The file type is commonly used to deliver hidden links, scripts, or bundled payloads.",
          advice: "Preview or sandbox the file before opening.",
          source: "MITRE T1566.001"
        });
      }
    });
  }

  function analyzeContent(text, findings) {
    const normalized = normalizeText(text);
    CONTENT_RULES.forEach((rule) => {
      if (rule.regex.test(normalized)) addFinding(findings, rule);
    });

    INTENT_RULES.forEach((rule) => {
      if (rule.regexes.every((regex) => regex.test(normalized))) {
        addFinding(findings, {
          id: rule.id,
          severity: severityFromPoints(rule.weight),
          points: rule.weight,
          category: "AI content intent",
          where: rule.label,
          detail: `Local text-intent classifier matched a ${rule.label} pattern.`,
          advice: "Treat the message intent as suspicious unless verified outside this flow.",
          source: "Veyra local NLP-style intent model"
        });
      }
    });

    const hasLinkAction = /\b(click|open|view|download|sign in|login|verify|confirm|update)\b/i.test(normalized);
    const hasSensitive = /\b(password|mfa|2fa|bank|routing|credit card|ssn|social security|tax id)\b/i.test(normalized);
    if (hasLinkAction && hasSensitive) {
      addFinding(findings, {
        id: "action-plus-sensitive-data",
        severity: "high",
        points: 23,
        category: "Data integrity",
        where: "Action request",
        detail: "The content combines an action request with sensitive-data language.",
        advice: "Avoid entering private information from this flow.",
        source: "CISA phishing guidance"
      });
    }
  }

  function analyzeSender(input, findings) {
    const sender = parseEmail(input.sender || "");
    const replyTo = parseEmail(input.replyTo || "");
    const returnPath = parseEmail(input.returnPath || "");
    const displayText = `${sender.display} ${input.senderDisplay || ""}`;

    if (!sender.host && !displayText) return;

    if (sender.host && RISKY_TLDS.has(getTld(sender.host))) {
      addFinding(findings, {
        id: "sender-risky-tld",
        severity: "medium",
        points: 13,
        category: "Sender",
        where: sender.host,
        detail: `The sender uses a higher-risk .${getTld(sender.host)} domain.`,
        advice: "Confirm the sender through another channel.",
        source: "Email spoofing pattern"
      });
    }

    const brandInSender = sender.host ? brandForHost(sender.host) : null;
    if (brandInSender && !brandInSender.official) {
      addFinding(findings, {
        id: "sender-brand-impersonation",
        severity: "high",
        points: 26,
        category: "Sender",
        where: sender.host,
        detail: `The sender domain appears to impersonate ${brandInSender.brand}.`,
        advice: "Do not trust this sender without verification.",
        source: "Email spoofing pattern"
      });
    }

    BRAND_WORDS.forEach((brand) => {
      const officialDomains = TRUSTED_BRAND_DOMAINS[brand] || [];
      if (new RegExp(`\\b${brand}\\b`, "i").test(displayText) && sender.host && !officialDomains.some((domain) => sender.root === domain || sender.host.endsWith(`.${domain}`))) {
        addFinding(findings, {
          id: "display-name-brand-mismatch",
          severity: "high",
          points: 25,
          category: "Display-name spoofing",
          where: sender.host,
          detail: `The display name references ${brand}, but the sender domain is not an official ${brand} domain.`,
          advice: "Treat the display name as untrusted and verify the domain.",
          source: "Email spoofing pattern"
        });
      }
    });

    if (sender.host && /(gmail|outlook|yahoo|proton)\.com$/.test(sender.host) && /(invoice|payroll|security|support|admin|it team|help desk)/i.test(displayText)) {
      addFinding(findings, {
        id: "official-free-mail",
        severity: "medium",
        points: 15,
        category: "Sender",
        where: sender.host,
        detail: "An official-sounding sender is using a consumer email domain.",
        advice: "Check whether this sender normally uses a company domain.",
        source: "Email spoofing pattern"
      });
    }

    if (replyTo.host && sender.host && replyTo.root !== sender.root) {
      addFinding(findings, {
        id: "reply-to-mismatch",
        severity: "medium",
        points: 17,
        category: "Sender authentication",
        where: `${sender.host} -> ${replyTo.host}`,
        detail: "The Reply-To domain differs from the sender domain.",
        advice: "Do not reply with sensitive information until the sender is verified.",
        source: "Email spoofing pattern"
      });
    }

    if (returnPath.host && sender.host && returnPath.root !== sender.root) {
      addFinding(findings, {
        id: "return-path-mismatch",
        severity: "medium",
        points: 15,
        category: "Sender authentication",
        where: `${sender.host} -> ${returnPath.host}`,
        detail: "The Return-Path domain differs from the visible sender domain.",
        advice: "Use original email headers or a mail security API to verify alignment.",
        source: "Gmail SPF/DKIM/DMARC guidance"
      });
    }

    const auth = input.authentication || {};
    ["spf", "dkim", "dmarc"].forEach((key) => {
      const value = String(auth[key] || "").toLowerCase();
      if (["fail", "softfail", "none", "neutral", "temperror", "permerror"].includes(value)) {
        addFinding(findings, {
          id: `${key}-auth-failed`,
          severity: key === "dmarc" ? "high" : "medium",
          points: key === "dmarc" ? 24 : 15,
          category: "Sender authentication",
          where: key.toUpperCase(),
          detail: `${key.toUpperCase()} did not pass or was not available.`,
          advice: "Treat sender identity as weaker until authenticated by SPF, DKIM, and DMARC alignment.",
          source: "Gmail sender guidelines"
        });
      }
    });
  }

  function analyzeForms(input, findings) {
    const forms = Array.isArray(input.forms) ? input.forms : [];
    forms.slice(0, 20).forEach((form) => {
      const actionHost = getHost(form.action || input.url || "");
      const pageHost = getHost(input.url || "");
      if (form.hasPassword && input.url && safeUrl(input.url)?.protocol !== "https:") {
        addFinding(findings, {
          id: "password-form-no-https",
          severity: "high",
          points: 29,
          category: "Credential harvesting",
          where: pageHost || "Current page",
          detail: "The page asks for a password without HTTPS.",
          advice: "Do not submit credentials on this page.",
          source: "Google Safe Browsing URL checks"
        });
      }

      if (form.hasPassword && actionHost && pageHost && rootDomain(actionHost) !== rootDomain(pageHost)) {
        addFinding(findings, {
          id: "external-login-form-action",
          severity: "high",
          points: 24,
          category: "Credential harvesting",
          where: `${pageHost} -> ${actionHost}`,
          detail: "A login form submits to a different domain.",
          advice: "Verify the destination before entering credentials.",
          source: "MITRE T1566.002"
        });
      }

      const fields = (form.inputNames || []).join(" ");
      if (PAYMENT_FIELD_NAMES.test(fields) && !/checkout|billing|pay|cart/i.test(`${input.title || ""} ${input.url || ""}`)) {
        addFinding(findings, {
          id: "payment-fields-unexpected-context",
          severity: "medium",
          points: 17,
          category: "Website pattern model",
          where: actionHost || pageHost || "Form fields",
          detail: "The page contains payment-like fields outside an obvious checkout context.",
          advice: "Avoid entering payment data unless you intentionally started a trusted checkout.",
          source: "Veyra DOM/form feature model"
        });
      }

      if (SECRET_FIELD_NAMES.test(fields) && !form.hasPassword) {
        addFinding(findings, {
          id: "secret-fields-without-password-type",
          severity: "medium",
          points: 15,
          category: "Website pattern model",
          where: actionHost || pageHost || "Form fields",
          detail: "The form asks for secret-like values without using a normal password field.",
          advice: "Do not enter recovery phrases, OTPs, or private keys into unexpected forms.",
          source: "Veyra DOM/form feature model"
        });
      }
    });
  }

  function analyzePageIdentity(input, findings) {
    const pageHost = getHost(input.url || "");
    const titleAndText = `${input.title || ""} ${String(input.text || "").slice(0, 1200)}`;
    BRAND_WORDS.forEach((brand) => {
      const officialDomains = TRUSTED_BRAND_DOMAINS[brand] || [];
      if (new RegExp(`\\b${brand}\\b`, "i").test(titleAndText) && pageHost && !officialDomains.some((domain) => rootDomain(pageHost) === domain || pageHost.endsWith(`.${domain}`))) {
        addFinding(findings, {
          id: "page-brand-mismatch",
          severity: "medium",
          points: 18,
          category: "Website impersonation",
          where: pageHost,
          detail: `The page references ${brand}, but the domain is not an official ${brand} domain.`,
          advice: "Do not sign in unless you can verify the domain.",
          source: "MITRE T1566.002"
        });
      }
    });

    const forms = Array.isArray(input.forms) ? input.forms : [];
    if (forms.some((form) => form.hasPassword) && Number(input.externalHostCount || 0) > 12) {
      addFinding(findings, {
        id: "login-page-many-external-hosts",
        severity: "medium",
        points: 16,
        category: "Website pattern model",
        where: pageHost || "Current page",
        detail: "A login-like page loads or links to many external domains.",
        advice: "Verify the domain before entering credentials.",
        source: "Veyra DOM/link graph model"
      });
    }
  }

  function analyzeDocumentPattern(input, findings) {
    if (input.surface !== "document" && input.surface !== "download") return;
    const features = extractSurfaceFeatures(input);
    if (features.links.count >= 6 && features.text.urgencyHits + features.text.credentialHits > 0) {
      addFinding(findings, {
        id: "document-link-heavy-phish-pattern",
        severity: "medium",
        points: 17,
        category: "Document pattern model",
        where: input.title || "Document",
        detail: "The document contains many links plus credential or urgency language.",
        advice: "Do not follow links from the document until the sender and destination are verified.",
        source: "Veyra document feature model"
      });
    }

    if (features.attachments.archiveCount > 0 && features.text.attachmentLureHits > 0) {
      addFinding(findings, {
        id: "archive-plus-execution-lure",
        severity: "high",
        points: 24,
        category: "Document pattern model",
        where: input.title || "Document",
        detail: "The file pattern combines archive content with instructions to open or enable content.",
        advice: "Use a sandbox or trusted viewer before opening extracted files.",
        source: "Veyra attachment feature model"
      });
    }
  }

  function scoreFindings(findings) {
    const raw = findings.reduce((sum, finding) => sum + (finding.points || 0), 0);
    const highCount = findings.filter((finding) => finding.severity === "high").length;
    const diversityBonus = new Set(findings.map((finding) => finding.category)).size * 3;
    return Math.min(100, raw + diversityBonus + Math.max(0, highCount - 1) * 6);
  }

  function levelForScore(score) {
    if (score >= 55) return "dangerous";
    if (score >= 25) return "moderate";
    return "safe";
  }

  function recommendationFor(level) {
    if (level === "dangerous") return "Do not proceed. Use a known trusted site or contact the sender through a separate channel.";
    if (level === "moderate") return "Proceed only if you expected this and can verify the sender, domain, and requested action.";
    return "No strong phishing indicators were found. Stay cautious with sensitive data.";
  }

  function analyzeSurface(input) {
    const payload = input || {};
    const findings = [];
    const score = 0;
    const level = levelForScore(score);
    return {
      id: payload.id || `${Date.now()}`,
      surface: payload.surface || "website",
      title: payload.title || "Untitled scan",
      url: payload.url || "",
      score,
      level,
      features: extractSurfaceFeatures(payload),
      findings,
      recommendation: recommendationFor(level),
      confirmationKeyword: level === "safe" ? "" : "I UNDERSTAND",
      model: "Veyra ML/AI feature collector v0.3",
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
    canonicalizeUrlForCheck
  };
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : window);
