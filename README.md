# Veyra

Veyra is a hackathon-stage Chrome extension prototype for explainable phishing and spoofing protection across email, documents/downloads, and websites.

## What is built

- Manifest V3 Chrome extension scaffold.
- Shared hybrid AI/ML feature engine for sender identity, recipient/context signals, subject-vs-body semantic mismatch, visual impersonation, links, attachments, and page/document objects.
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

## Optional local ML model

Veyra can call local ML classifiers when the model servers are running.

Recommended Python setup:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r ml\requirements.txt
```

If your global Python install throws a pandas/numpy import error, use the virtual environment above. If the venv still has trouble, reinstall inside the venv:

```powershell
python -m pip install --force-reinstall pandas numpy
```

Train and run the first email phishing model:

```powershell
python ml\train_email_model.py --data ml\data\email_training.csv
python ml\email_model_server.py
```

That starts `http://127.0.0.1:8766/analyze`, which the extension already uses for local AI/ML email scoring. The included CSV is a demo dataset only; replace it with real labeled email data before relying on the model.

Generate, train, and test the visual spoofing detector:

```powershell
python ml\generate_spoof_data.py --out ml\data\spoof_training.csv
python ml\train_spoof_detector.py --data ml\data\spoof_training.csv
python ml\spoof_cli.py "supp0rt@paypa1.com"
python ml\spoof_cli.py "https://rnicrosoft.com/login"
python ml\spoof_cli.py "google.com"
```

Run the visual spoofing detector server so the extension can use it during Gmail scans:

```powershell
python ml\spoof_model_server.py
```

That starts `http://127.0.0.1:8767/score`. Gmail scans send the visible sender address and email links to this local server. The returned ML score and character flags are added to the same report object used by the Gmail bar and details panel.

The spoof detector returns a binary label, probability score, and exact flagged characters/substrings with positions.

Run the optional URL XGBoost model:

```powershell
python ml\url_model_server.py
```

The server loads `C:\Users\ritwi_m2ofaxd\Downloads\XGBoostClassifier.pickle.dat` by default. If it is running, website URLs and links found in emails/documents can receive an extra `ML URL model` finding. If it is not running, Veyra silently falls back to the explainable JavaScript rules.

If it is not running, Veyra falls back to local feature evidence: visual confusables, sender/header alignment signals available from the page, semantic mismatch, and object context. If the pickle fails with an older-XGBoost serialization error, convert it from the original training environment:

```powershell
python ml\convert_legacy_xgboost.py C:\Users\ritwi_m2ofaxd\Downloads\XGBoostClassifier.pickle.dat --out ml\xgboost_url_model.json
$env:VEYRA_MODEL_PATH="C:\Users\ritwi_m2ofaxd\OneDrive\Documents\Coding\Njx Hackathon\ml\xgboost_url_model.json"
python ml\url_model_server.py
```

## AI/ML layers now wired

The prototype now includes local-first AI plumbing for URL features, email subject/body intent mismatch, sender anomaly memory, website DOM/form features, document/attachment object context, evidence-bound AI risk summaries, and user feedback labels.

Read the implementation map in `docs/ai-implementation.md`.

Optional local AI endpoint:

```text
POST http://127.0.0.1:8766/analyze
```

The extension sends email text to this endpoint only when it is running on localhost for local model scoring. Website/document payloads stay feature-focused. Do not point this endpoint to a cloud service without consent, redaction, retention limits, and a privacy review.

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

Veyra should not compete as only another phishing detector. The stronger story is:

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

- Add URL redirect-chain expansion and domain reputation checks.
- Add attachment parsing in a sandboxed backend or local companion app.
- Add allowlist/denylist management.
- Add an onboarding privacy screen.
- Add test fixtures for safe, moderate, and dangerous examples.
- Wire the visual spoofing detector model into the extension service worker automatically.
