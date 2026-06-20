# ShieldThread

ShieldThread is a hackathon-stage Chrome extension prototype for explainable phishing and spoofing protection across email, documents/downloads, and websites.

## What is built

- Manifest V3 Chrome extension scaffold.
- Shared heuristic risk engine for sender, content, links, attachments, urgency language, brand impersonation, dangerous file types, and sensitive-data prompts.
- Gmail content script that watches opened messages and renders a right-side risk bar.
- Document/Drive/file content script that renders a compact document scan rail.
- Website gate that briefly blocks a page, shows a small waiting game, scans visible page content/links/download-like URLs, then displays a short risk report.
- Confirmation keyword flow for moderate and dangerous pages.
- Popup dashboard with recent scans and prototype settings.

## Load locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked**.
4. Choose this folder: `C:\Users\ritwi_m2ofaxd\OneDrive\Documents\Coding\Njx Hackathon`.
5. To test local files, open the extension details page and enable **Allow access to file URLs**.

## Competitive landscape

Products already exist in this neighborhood:

- Push Security: browser-layer detection for AiTM phishing, ClickFix, session hijacking, and behavior attackers cannot easily rotate.
- PIXM: browser phishing protection using AI/computer vision to detect impersonation at point of click.
- SquareX: browser detection and response, isolation, and client-side attack mitigation for enterprises.
- LayerX: browser and AI interaction security with phishing, data leakage, SaaS, and extension governance.
- Bolster CheckPhish: URL/email scanning, typosquat monitoring, brand impersonation, and takedown workflows.
- Enterprise email security: Proofpoint, Mimecast, Microsoft Defender for Office 365, IRONSCALES, Sublime Security, Fortinet/Perception Point.
- Consumer/browser safety: Google Safe Browsing, Surfshark/NordVPN-style link warnings, and many simple phishing URL Chrome extensions.

## Differentiation

ShieldThread should not compete as only another phishing detector. The stronger story is:

- Explainable short reports: show what was found, where, why it matters, and what to do.
- Cross-surface continuity: email, file/document, download, and website risk report in one extension UX.
- User-comprehension gate: require a typed acknowledgement for moderate/high risk so users pause before overriding.
- Trust-building visualization: visible protection state, risk color, scan progress, and itemized findings.
- Personal/SMB wedge: simpler and more transparent than enterprise-only browser security platforms.
- Privacy-first positioning: local-first heuristics, optional model calls, strict redaction, and no content sale.

## Product risks and flaws to fix

- A Chrome extension cannot reliably read every attachment or local document without user permission, file access, sandboxing, or a cloud/local analysis pipeline.
- Gmail DOM scanning is brittle because Gmail markup changes. A production version should use the Gmail API or Workspace add-on model where possible.
- Blocking every website with a waiting game may annoy users. Use risk-based gating, prefetching, allowlists, and fast local checks.
- AI can hallucinate security claims. The report should cite concrete evidence and use deterministic checks alongside ML.
- Ads beside security decisions can harm trust and privacy. If ads are used, never show them on high-risk reports, never target from scanned content, and prefer sponsorships or freemium.
- Scanning private emails/documents creates a major privacy burden. The company needs data minimization, local processing, clear consent, encryption, retention limits, and enterprise controls.
- Attackers can evade simple text/URL heuristics. Production needs reputation feeds, sandboxing, attachment detonation, OCR/visual similarity, redirect-chain analysis, and model evaluation.
- The extension itself becomes a sensitive target. It needs least-privilege permissions, no remotely hosted code, signed releases, security review, and transparent data handling.

## Next build steps

- Add a local model/API adapter behind the risk engine.
- Add URL redirect-chain expansion and domain reputation checks.
- Add attachment parsing in a sandboxed backend or local companion app.
- Add allowlist/denylist management.
- Add an onboarding privacy screen.
- Add test fixtures for safe, moderate, and dangerous examples.
