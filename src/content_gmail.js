function veyraGmailEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function veyraRiskColor(level) {
  if (level === "dangerous") return "#dc2626";
  if (level === "moderate") return "#d97706";
  return "#15803d";
}

function veyraRiskLabel(level) {
  if (level === "dangerous") return "High";
  if (level === "moderate") return "Moderate";
  return "Low";
}

function veyraExtractGmailMessage() {
  const subject = document.querySelector("h2[data-thread-perm-id], h2.hP")?.innerText || "Gmail message";
  const senderNode = document.querySelector("[email], .gD[email], .gD");
  const sender = senderNode?.getAttribute("email") || senderNode?.innerText || "";
  const recipients = [...document.querySelectorAll(".g2[email], .hb .g2[email], [name='to'] [email], [aria-label*='To:'] [email]")]
    .map((node) => node.getAttribute("email") || node.innerText || "")
    .filter(Boolean);
  const detailText = [...document.querySelectorAll(".ajA, .g3, .hb, .acZ")]
    .map((node) => node.innerText || "")
    .join(" ")
    .slice(0, 4000);
  const bodyNodes = [...document.querySelectorAll(".a3s, [role='listitem']")].slice(-4);
  const text = bodyNodes.map((node) => node.innerText).join("\n").slice(0, 22000);
  const links = [...document.querySelectorAll(".a3s a[href], [role='listitem'] a[href]")]
    .map((link) => ({ href: link.href, text: link.innerText || link.textContent || link.href }));
  const attachments = [...document.querySelectorAll("[download_url], .aZo, .aQy")]
    .map((node) => node.innerText || node.getAttribute("aria-label") || "Attachment");
  return {
    surface: "email",
    title: subject,
    subject,
    sender,
    recipients,
    headerText: detailText,
    text: `${detailText}\n${text}`.trim(),
    links,
    attachments,
    url: location.href
  };
}

function veyraExtractRow(row) {
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

function veyraDateCellForRow(row) {
  return row.querySelector(".xW, td[role='gridcell']:last-child, [aria-label*='Date'], [title*='20']");
}

function veyraTooltipHtml(report) {
  const exact = report.findings.filter((finding) => String(finding.category || "").startsWith("Exact")).slice(0, 3);
  const semantic = report.findings.filter((finding) => String(finding.category || "").includes("AI") || String(finding.category || "").includes("ML")).slice(0, 3);
  const other = report.findings.filter((finding) => !exact.includes(finding) && !semantic.includes(finding)).slice(0, 2);
  const findingHtml = (finding) => `
    <div class="veyra-gmail-tooltip-finding">
      <b>${veyraGmailEscape(finding.category)}</b>
      <span>${veyraGmailEscape(finding.where)}</span>
      <p>${veyraGmailEscape(finding.detail)}</p>
    </div>
  `;
  const framework = report.framework ? `
    <div class="veyra-gmail-tooltip-finding">
      <b>${report.framework.senderSeenBefore ? "Known sender path" : "AI/ML email scan path"}</b>
      <span>${veyraGmailEscape(report.framework.steps?.mergeDecision || "allow")}</span>
      <p>${veyraGmailEscape(veyraFrameworkSummary(report))}</p>
    </div>
  ` : "";
  const aiSummary = report.ai?.summary ? `
    <div class="veyra-gmail-tooltip-ai">
      <b>AI interpretation</b>
      <p>${veyraGmailEscape(report.ai.summary)}</p>
    </div>
  ` : "";
  const exactHtml = exact.length ? `<div class="veyra-gmail-tooltip-section">Exact evidence</div>${exact.map(findingHtml).join("")}` : "";
  const semanticHtml = semantic.length ? `<div class="veyra-gmail-tooltip-section">AI/ML signals</div>${semantic.map(findingHtml).join("")}` : "";
  const otherHtml = other.length ? `<div class="veyra-gmail-tooltip-section">Model context</div>${other.map(findingHtml).join("")}` : "";

  return `
    <div class="veyra-gmail-tooltip-head">
      <strong>${veyraRiskLabel(report.level)} risk</strong>
      <span>${report.score}/100</span>
    </div>
    ${report.surface === "email-preview" ? "<p>Inbox preview score. Open the email for the full-message score.</p>" : ""}
    ${framework}
    ${aiSummary}
    ${exactHtml}
    ${semanticHtml}
    ${otherHtml || (!exactHtml && !semanticHtml ? "<p>No strong identity or AI/ML risk signals were found in the available preview.</p>" : "")}
    <em>${veyraGmailEscape(report.recommendation)}</em>
  `;
}

function veyraFrameworkSummary(report) {
  if (!report.framework) return "Veyra extracted sender, content, link, attachment, and visual-identity features.";
  if (report.framework.senderSeenBefore) return "This sender already passed a full Veyra scan, so the framework used the seen-before break path.";

  const checks = report.framework.checks || {};
  const flags = [];
  if (checks.senderSpoofed) flags.push("sender identity evidence");
  if (checks.linksOrAttachmentsSpoofed) flags.push("link or attachment evidence");
  if (checks.comprehensionFlags?.length) flags.push("AI semantic mismatch");
  return flags.length
    ? `Veyra checked ${flags.join(", ")} before the merged judgement.`
    : "Veyra checked exact identity features and AI/ML semantic features before the merged judgement.";
}

function veyraShowTooltip(anchor, report) {
  veyraHideTooltip();
  const tooltip = document.createElement("div");
  tooltip.className = "veyra-gmail-tooltip";
  tooltip.innerHTML = veyraTooltipHtml(report);
  document.body.appendChild(tooltip);

  const rect = anchor.getBoundingClientRect();
  const width = 348;
  const preferredLeft = rect.left - width - 42;
  const fallbackLeft = rect.right - width - 156;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, preferredLeft > 12 ? preferredLeft : fallbackLeft));
  const top = Math.max(12, Math.min(window.innerHeight - tooltip.offsetHeight - 12, rect.top - 18));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function veyraHideTooltip() {
  document.querySelector(".veyra-gmail-tooltip")?.remove();
}

function veyraRenderRowRisk(row, report) {
  const dateCell = veyraDateCellForRow(row);
  if (!dateCell) return;

  dateCell.querySelector(".veyra-row-risk")?.remove();
  const color = veyraRiskColor(report.level);
  const bar = document.createElement("span");
  bar.className = `veyra-row-risk veyra-row-risk-${report.level}`;
  bar.tabIndex = 0;
  bar.setAttribute("role", "button");
  bar.setAttribute("aria-label", `Veyra ${veyraRiskLabel(report.level)} risk, ${report.score} out of 100`);
  bar.innerHTML = `
    <span class="veyra-row-risk-track"><span style="width:${Math.max(8, report.score)}%;background:${color}"></span></span>
    <span class="veyra-row-risk-score">${report.score}</span>
  `;

  bar.addEventListener("mouseenter", () => {
    bar.classList.add("veyra-row-risk-active");
    veyraShowTooltip(bar, report);
  });
  bar.addEventListener("mouseleave", () => {
    bar.classList.remove("veyra-row-risk-active");
    veyraHideTooltip();
  });
  bar.addEventListener("focus", () => {
    bar.classList.add("veyra-row-risk-active");
    veyraShowTooltip(bar, report);
  });
  bar.addEventListener("blur", () => {
    bar.classList.remove("veyra-row-risk-active");
    veyraHideTooltip();
  });
  bar.addEventListener("click", (event) => {
    event.stopPropagation();
    bar.classList.add("veyra-row-risk-active");
    veyraShowTooltip(bar, report);
  });

  dateCell.classList.add("veyra-date-cell");
  dateCell.insertBefore(bar, dateCell.firstChild);
}

function veyraRequestEmailPreview(payload, callback) {
  const fallback = () => {
    const report = window.VeyraRiskEngine?.analyzeSurface(payload);
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

function veyraScanGmailRows() {
  const rows = [...document.querySelectorAll("tr.zA, div[role='main'] tr[role='row']")].slice(0, 80);
  rows.forEach((row) => {
    if (row.dataset.veyraScanned === "true" || row.dataset.veyraScanState === "pending") return;
    const payload = veyraExtractRow(row);
    if (!payload.sender && !payload.text.trim()) return;

    row.dataset.veyraScanState = "pending";
    veyraRequestEmailPreview(payload, (report) => {
      if (!report || !row.isConnected) {
        delete row.dataset.veyraScanState;
        return;
      }

      row.dataset.veyraScanState = "done";
      row.dataset.veyraScanned = "true";
      row.dataset.veyraRisk = report.level;
      veyraRenderRowRisk(row, report);
    });
  });
}

function veyraRenderGmailBar(report) {
  document.querySelector(".veyra-email-bar")?.remove();
  const color = veyraRiskColor(report.level);
  const label = `${veyraRiskLabel(report.level)} Risk`;
  const frameworkSummary = veyraFrameworkSummary(report);
  const aiSummary = report.ai?.summary || "";
  const bar = document.createElement("aside");
  bar.className = "veyra-email-bar";
  bar.innerHTML = `
    <strong>Veyra Email Scan</strong>
    <div class="veyra-meter"><div style="width:${report.score}%;background:${color}"></div></div>
    <div style="display:flex;justify-content:space-between;gap:10px">
      <span style="color:${color};font-weight:800">${label}</span>
      <span>${report.score}/100</span>
    </div>
    <p style="margin:10px 0 0;color:#4b5563;font-size:13px">${veyraGmailEscape(report.findings[0]?.detail || "No strong spoofing indicators found.")}</p>
    <p style="margin:8px 0 0;color:#475569;font-size:12px;line-height:1.42">${veyraGmailEscape(frameworkSummary)}</p>
    ${aiSummary ? `<p style="margin:8px 0 0;color:#475569;font-size:12px;line-height:1.42">${veyraGmailEscape(aiSummary)}</p>` : ""}
    <button class="veyra-button secondary" style="width:100%;margin-top:12px" type="button">View details</button>
  `;

  bar.querySelector("button").addEventListener("click", () => {
    const detail = document.createElement("div");
    detail.className = "veyra-doc-rail";
    detail.style.top = "96px";
    detail.innerHTML = `
      <strong>Findings</strong>
      <p><b>Framework</b>: ${veyraGmailEscape(frameworkSummary)}</p>
      ${aiSummary ? `<p><b>AI summary</b>: ${veyraGmailEscape(aiSummary)}</p>` : ""}
      ${report.findings.slice(0, 6).map((finding) => `<p><b>${veyraGmailEscape(finding.category)}</b>: ${veyraGmailEscape(finding.detail)}</p>`).join("") || "<p>No major findings.</p>"}
    `;
    document.body.appendChild(detail);
    setTimeout(() => detail.remove(), 9000);
  });

  document.body.appendChild(bar);
}

let veyraLastFingerprint = "";

function veyraScanOpenedGmailMessage() {
  const payload = veyraExtractGmailMessage();
  const fingerprint = `${payload.title}|${payload.sender}|${payload.text.slice(0, 160)}`;
  if (!payload.text || fingerprint === veyraLastFingerprint) return;

  veyraLastFingerprint = fingerprint;
  chrome.runtime.sendMessage({ type: "SCAN_SURFACE", payload }, veyraRenderGmailBar);
}

function veyraScanGmail() {
  veyraScanGmailRows();
  veyraScanOpenedGmailMessage();
}

const veyraObserver = new MutationObserver(() => {
  window.clearTimeout(window.__veyraGmailTimer);
  window.__veyraGmailTimer = window.setTimeout(veyraScanGmail, 500);
});

veyraObserver.observe(document.body, { childList: true, subtree: true });
window.setTimeout(veyraScanGmail, 900);
