function shieldThreadColor(level) {
  if (level === "dangerous") return "#dc2626";
  if (level === "moderate") return "#d97706";
  return "#15803d";
}

function shieldThreadLabel(level) {
  if (level === "dangerous") return "High Risk";
  if (level === "moderate") return "Moderate Risk";
  return "Low Risk";
}

function shieldThreadEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function shieldThreadCreateReport(report, options = {}) {
  const rail = document.createElement("aside");
  rail.className = options.className || "shieldthread-rail";

  const color = shieldThreadColor(report.level);
  const findings = report.findings.length
    ? report.findings.slice(0, 8).map((finding) => `
      <div class="shieldthread-finding">
        <strong>${shieldThreadEscape(finding.category)}: ${shieldThreadEscape(finding.where)}</strong>
        <span style="background:${finding.severity === "high" ? "#fee2e2" : finding.severity === "medium" ? "#fef3c7" : "#dcfce7"};color:${finding.severity === "high" ? "#b91c1c" : finding.severity === "medium" ? "#92400e" : "#166534"}">${finding.severity.toUpperCase()}</span>
        <p>${shieldThreadEscape(finding.detail)}</p>
        <p><b>Advice:</b> ${shieldThreadEscape(finding.advice)}</p>
        <p><b>Evidence:</b> ${shieldThreadEscape(finding.source)} - ${finding.points || 0} pts</p>
      </div>`).join("")
    : `<div class="shieldthread-finding"><strong>No major indicators found</strong><p>ShieldThread did not find strong phishing or spoofing patterns in this scan.</p></div>`;

  rail.innerHTML = `
    <div class="shieldthread-report-title">
      <h2>ShieldThread Risk Report</h2>
      ${options.closable ? `<button class="shieldthread-close" type="button" aria-label="Close">x</button>` : ""}
    </div>
    <div class="shieldthread-risk">
      <div class="shieldthread-risk-icon" style="background:${color}">${report.level === "safe" ? "OK" : "!"}</div>
      <div>
        <h3 style="color:${color}">${shieldThreadLabel(report.level)}</h3>
        <p>Score ${report.score}/100 - ${report.surface}</p>
      </div>
    </div>
    ${findings}
    <div class="shieldthread-finding">
      <strong>Recommendation</strong>
      <p>${shieldThreadEscape(report.recommendation)}</p>
    </div>
  `;

  if (options.closable) {
    rail.querySelector(".shieldthread-close").addEventListener("click", () => rail.remove());
  }

  return rail;
}
