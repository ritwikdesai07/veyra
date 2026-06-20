function shieldThreadDocumentEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function shieldThreadCollectDocument() {
  const currentHost = location.hostname.replace(/^www\./, "").toLowerCase();
  const links = [...document.links].map((link) => ({
    href: link.href,
    text: link.innerText || link.textContent || link.getAttribute("aria-label") || link.href
  }));
  const linkHosts = links.map((link) => {
    try {
      return new URL(link.href).hostname.replace(/^www\./, "").toLowerCase();
    } catch (_error) {
      return "";
    }
  }).filter(Boolean);
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
    attachments: attachmentNames,
    externalHostCount: new Set(linkHosts.filter((host) => host && host !== currentHost)).size,
    scriptHostCount: new Set([...document.scripts].map((script) => {
      try {
        return script.src ? new URL(script.src).hostname.replace(/^www\./, "").toLowerCase() : "";
      } catch (_error) {
        return "";
      }
    }).filter((host) => host && host !== currentHost)).size,
    iframeCount: document.querySelectorAll("iframe").length
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
    ${report.ai?.summary ? `<p style="margin:8px 0 0;color:#4b5563;font-size:12px">${shieldThreadDocumentEscape(report.ai.summary)}</p>` : ""}
  `;
  document.body.appendChild(rail);
}

function shieldThreadScanDocument() {
  chrome.runtime.sendMessage({ type: "SCAN_SURFACE", payload: shieldThreadCollectDocument() }, shieldThreadRenderDocumentRail);
}

window.setTimeout(shieldThreadScanDocument, 1400);
