function shieldThreadGmailEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function shieldThreadRiskColor(level) {
  if (level === "dangerous") return "#dc2626";
  if (level === "moderate") return "#d97706";
  return "#15803d";
}

function shieldThreadRiskLabel(level) {
  if (level === "dangerous") return "High";
  if (level === "moderate") return "Moderate";
  return "Low";
}

function shieldThreadExtractGmailMessage() {
  const subject = document.querySelector("h2[data-thread-perm-id], h2.hP")?.innerText || "Gmail message";
  const senderNode = document.querySelector("[email], .gD[email], .gD");
  const sender = senderNode?.getAttribute("email") || senderNode?.innerText || "";
  const bodyNodes = [...document.querySelectorAll(".a3s, [role='listitem']")].slice(-4);
  const text = bodyNodes.map((node) => node.innerText).join("\n").slice(0, 22000);
  const links = [...document.querySelectorAll(".a3s a[href], [role='listitem'] a[href]")]
    .map((link) => ({ href: link.href, text: link.innerText || link.textContent || link.href }));
  const attachments = [...document.querySelectorAll("[download_url], .aZo, .aQy")]
    .map((node) => node.innerText || node.getAttribute("aria-label") || "Attachment");
  return { surface: "email", title: subject, sender, text, links, attachments, url: location.href };
}

function shieldThreadExtractRow(row) {
  const senderNode = row.querySelector("[email], .yP[email], .zF[email], .bA4 span[email], .yX.xY .yP, .zF");
  const sender = senderNode?.getAttribute("email") || senderNode?.getAttribute("name") || senderNode?.innerText || "";
  const subject = row.querySelector(".bog, .y6 span[id], [data-thread-id] .bog")?.innerText || "";
  const snippet = row.querySelector(".y2, .y6")?.innerText || "";
  const attachments = [...row.querySelectorAll("[title], [aria-label]")]
    .map((node) => node.getAttribute("title") || node.getAttribute("aria-label") || "")
    .filter((value) => /\.(pdf|docx?|xlsx?|pptx?|zip|exe|js|scr|msi|docm|xlsm|html?)\b/i.test(value));
  const id = row.getAttribute("data-legacy-message-id") || row.getAttribute("data-legacy-thread-id") || row.id || `${sender}|${subject}|${snippet}`.slice(0, 180);

  return {
    id: `gmail-row-${id}`,
    surface: "email-preview",
    title: subject || "Inbox message",
    sender,
    text: `${subject} ${snippet}`,
    links: [],
    attachments,
    url: location.href
  };
}

function shieldThreadDateCellForRow(row) {
  return row.querySelector(".xW, td[role='gridcell']:last-child, [aria-label*='Date'], [title*='20']");
}

function shieldThreadTooltipHtml(report) {
  const findings = report.findings.slice(0, 4).map((finding) => `
    <div class="shieldthread-gmail-tooltip-finding">
      <b>${shieldThreadGmailEscape(finding.category)}</b>
      <span>${shieldThreadGmailEscape(finding.where)}</span>
      <p>${shieldThreadGmailEscape(finding.detail)}</p>
    </div>
  `).join("");
  const framework = report.framework ? `
    <div class="shieldthread-gmail-tooltip-finding">
      <b>${report.framework.senderSeenBefore ? "Known sender path" : "First-pass spoofing framework"}</b>
      <span>${shieldThreadGmailEscape(report.framework.steps?.mergeDecision || "allow")}</span>
      <p>${shieldThreadGmailEscape(shieldThreadFrameworkSummary(report))}</p>
    </div>
  ` : "";

  return `
    <div class="shieldthread-gmail-tooltip-head">
      <strong>${shieldThreadRiskLabel(report.level)} risk</strong>
      <span>${report.score}/100</span>
    </div>
    ${framework}
    ${findings || "<p>No strong spoofing indicators found in the preview text.</p>"}
    <em>${shieldThreadGmailEscape(report.recommendation)}</em>
  `;
}

function shieldThreadFrameworkSummary(report) {
  if (!report.framework) return "Standard content, link, and sender checks were applied.";
  if (report.framework.senderSeenBefore) return "This sender already passed a full ShieldThread scan, so the framework used the seen-before break path.";

  const checks = report.framework.checks || {};
  const flags = [];
  if (checks.senderSpoofed) flags.push("sender spoofing");
  if (checks.linksOrAttachmentsSpoofed) flags.push("link or attachment spoofing");
  if (checks.comprehensionFlags?.length) flags.push("content intent");
  return flags.length
    ? `Unknown sender was checked for ${flags.join(", ")} before the merged judgement.`
    : "Unknown sender was checked for sender, link, attachment, and content-spoofing signals.";
}

function shieldThreadShowTooltip(anchor, report) {
  shieldThreadHideTooltip();
  const tooltip = document.createElement("div");
  tooltip.className = "shieldthread-gmail-tooltip";
  tooltip.innerHTML = shieldThreadTooltipHtml(report);
  document.body.appendChild(tooltip);

  const rect = anchor.getBoundingClientRect();
  const width = 320;
  const preferredLeft = rect.left - width - 28;
  const fallbackLeft = rect.right - width - 132;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, preferredLeft > 12 ? preferredLeft : fallbackLeft));
  const top = Math.max(12, Math.min(window.innerHeight - tooltip.offsetHeight - 12, rect.top - 18));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function shieldThreadHideTooltip() {
  document.querySelector(".shieldthread-gmail-tooltip")?.remove();
}

function shieldThreadRenderRowRisk(row, report) {
  const dateCell = shieldThreadDateCellForRow(row);
  if (!dateCell) return;

  dateCell.querySelector(".shieldthread-row-risk")?.remove();
  const color = shieldThreadRiskColor(report.level);
  const bar = document.createElement("span");
  bar.className = `shieldthread-row-risk shieldthread-row-risk-${report.level}`;
  bar.tabIndex = 0;
  bar.setAttribute("role", "button");
  bar.setAttribute("aria-label", `ShieldThread ${shieldThreadRiskLabel(report.level)} risk, ${report.score} out of 100`);
  bar.innerHTML = `
    <span class="shieldthread-row-risk-track"><span style="width:${Math.max(8, report.score)}%;background:${color}"></span></span>
    <span class="shieldthread-row-risk-score">${report.score}</span>
  `;

  bar.addEventListener("mouseenter", () => {
    bar.classList.add("shieldthread-row-risk-active");
    shieldThreadShowTooltip(bar, report);
  });
  bar.addEventListener("mouseleave", () => {
    bar.classList.remove("shieldthread-row-risk-active");
    shieldThreadHideTooltip();
  });
  bar.addEventListener("focus", () => {
    bar.classList.add("shieldthread-row-risk-active");
    shieldThreadShowTooltip(bar, report);
  });
  bar.addEventListener("blur", () => {
    bar.classList.remove("shieldthread-row-risk-active");
    shieldThreadHideTooltip();
  });
  bar.addEventListener("click", (event) => {
    event.stopPropagation();
    bar.classList.add("shieldthread-row-risk-active");
    shieldThreadShowTooltip(bar, report);
  });

  dateCell.classList.add("shieldthread-date-cell");
  dateCell.insertBefore(bar, dateCell.firstChild);
}

function shieldThreadRequestEmailPreview(payload, callback) {
  const fallback = () => {
    const report = window.ShieldThreadRiskEngine?.analyzeSurface(payload);
    callback(report || null);
  };

  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    fallback();
    return;
  }

  chrome.runtime.sendMessage({ type: "SCAN_EMAIL_PREVIEW", payload }, (report) => {
    if (chrome.runtime.lastError || !report) {
      fallback();
      return;
    }
    callback(report);
  });
}

function shieldThreadScanGmailRows() {
  const rows = [...document.querySelectorAll("tr.zA, div[role='main'] tr[role='row']")].slice(0, 80);
  rows.forEach((row) => {
    if (row.dataset.shieldThreadScanned === "true" || row.dataset.shieldThreadScanState === "pending") return;
    const payload = shieldThreadExtractRow(row);
    if (!payload.sender && !payload.text.trim()) return;

    row.dataset.shieldThreadScanState = "pending";
    shieldThreadRequestEmailPreview(payload, (report) => {
      if (!report || !row.isConnected) {
        delete row.dataset.shieldThreadScanState;
        return;
      }

      row.dataset.shieldThreadScanState = "done";
      row.dataset.shieldThreadScanned = "true";
      row.dataset.shieldThreadRisk = report.level;
      shieldThreadRenderRowRisk(row, report);
    });
  });
}

function shieldThreadRenderGmailBar(report) {
  document.querySelector(".shieldthread-email-bar")?.remove();
  const color = shieldThreadRiskColor(report.level);
  const label = `${shieldThreadRiskLabel(report.level)} Risk`;
  const frameworkSummary = shieldThreadFrameworkSummary(report);
  const aiSummary = report.ai?.summary || "";
  const bar = document.createElement("aside");
  bar.className = "shieldthread-email-bar";
  bar.innerHTML = `
    <strong>ShieldThread Email Scan</strong>
    <div class="shieldthread-meter"><div style="width:${report.score}%;background:${color}"></div></div>
    <div style="display:flex;justify-content:space-between;gap:10px">
      <span style="color:${color};font-weight:800">${label}</span>
      <span>${report.score}/100</span>
    </div>
    <p style="margin:10px 0 0;color:#4b5563;font-size:13px">${shieldThreadGmailEscape(report.findings[0]?.detail || "No strong spoofing indicators found.")}</p>
    <p style="margin:8px 0 0;color:#475569;font-size:12px;line-height:1.42">${shieldThreadGmailEscape(frameworkSummary)}</p>
    ${aiSummary ? `<p style="margin:8px 0 0;color:#475569;font-size:12px;line-height:1.42">${shieldThreadGmailEscape(aiSummary)}</p>` : ""}
    <button class="shieldthread-button secondary" style="width:100%;margin-top:12px" type="button">View details</button>
  `;

  bar.querySelector("button").addEventListener("click", () => {
    const detail = document.createElement("div");
    detail.className = "shieldthread-doc-rail";
    detail.style.top = "96px";
    detail.innerHTML = `
      <strong>Findings</strong>
      <p><b>Framework</b>: ${shieldThreadGmailEscape(frameworkSummary)}</p>
      ${aiSummary ? `<p><b>AI summary</b>: ${shieldThreadGmailEscape(aiSummary)}</p>` : ""}
      ${report.findings.slice(0, 6).map((finding) => `<p><b>${shieldThreadGmailEscape(finding.category)}</b>: ${shieldThreadGmailEscape(finding.detail)}</p>`).join("") || "<p>No major findings.</p>"}
    `;
    document.body.appendChild(detail);
    setTimeout(() => detail.remove(), 9000);
  });

  document.body.appendChild(bar);
}

let shieldThreadLastFingerprint = "";

function shieldThreadScanOpenedGmailMessage() {
  const payload = shieldThreadExtractGmailMessage();
  const fingerprint = `${payload.title}|${payload.sender}|${payload.text.slice(0, 160)}`;
  if (!payload.text || fingerprint === shieldThreadLastFingerprint) return;

  shieldThreadLastFingerprint = fingerprint;
  chrome.runtime.sendMessage({ type: "SCAN_SURFACE", payload }, shieldThreadRenderGmailBar);
}

function shieldThreadScanGmail() {
  shieldThreadScanGmailRows();
  shieldThreadScanOpenedGmailMessage();
}

const shieldThreadObserver = new MutationObserver(() => {
  window.clearTimeout(window.__shieldThreadGmailTimer);
  window.__shieldThreadGmailTimer = window.setTimeout(shieldThreadScanGmail, 500);
});

shieldThreadObserver.observe(document.body, { childList: true, subtree: true });
window.setTimeout(shieldThreadScanGmail, 900);
