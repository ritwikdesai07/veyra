function shieldThreadDocumentEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function shieldThreadCollectDocument() {
  const links = [...document.links].map((link) => link.href);
  const attachmentNames = [...document.querySelectorAll("[aria-label], [title], a[href]")]
    .map((node) => node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent || "")
    .filter((text) => /\.(pdf|docx?|xlsx?|pptx?|zip|exe|js|scr|msi|docm|xlsm)(\s|$)/i.test(text))
    .slice(0, 30);

  return {
    surface: "document",
    title: document.title || location.pathname.split("/").pop() || "Document",
    url: location.href,
    text: document.body ? document.body.innerText.slice(0, 20000) : document.title,
    links,
    attachments: attachmentNames
  };
}

function shieldThreadRenderDocumentRail(report) {
  document.querySelector(".shieldthread-doc-rail")?.remove();
  const color = report.level === "dangerous" ? "#dc2626" : report.level === "moderate" ? "#d97706" : "#15803d";
  const rail = document.createElement("aside");
  rail.className = "shieldthread-doc-rail";
  rail.innerHTML = `
    <strong>ShieldThread Document Scan</strong>
    <div class="shieldthread-meter"><div style="width:${report.score}%;background:${color}"></div></div>
    <p style="margin:8px 0;color:${color};font-weight:800">${report.level.toUpperCase()} - ${report.score}/100</p>
    <p style="margin:0;color:#4b5563;font-size:13px">${shieldThreadDocumentEscape(report.recommendation)}</p>
  `;
  document.body.appendChild(rail);
}

function shieldThreadScanDocument() {
  chrome.runtime.sendMessage({ type: "SCAN_SURFACE", payload: shieldThreadCollectDocument() }, shieldThreadRenderDocumentRail);
}

window.setTimeout(shieldThreadScanDocument, 1400);
