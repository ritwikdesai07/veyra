# Veyra AI Implementation

This build implements the seven AI/ML layers as local-first extension code with optional local model endpoints.

## 1. URL phishing model

- Built in: `src/service_worker.js` calls `http://127.0.0.1:8765/score` for URL XGBoost scoring.
- Built in: `src/risk_engine.js` now extracts URL feature vectors such as length, depth, HTTPS, shortener use, risky TLD, punycode, brand impersonation, and redirect parameters.
- Real model slot: run `ml/url_model_server.py` or replace `LOCAL_MODEL_ENDPOINT`.

## 2. Email content and header/context classifier

- Built in: `src/risk_engine.js` extracts sender, visible recipients, subject/header text, body text, links, and attachments from the Gmail DOM.
- Built in: exact detectors handle confusable characters, punycode, mixed scripts, display-name/domain mismatch, Reply-To mismatch, Return-Path mismatch, and supplied SPF/DKIM/DMARC failures.
- Built in: a local semantic feature layer compares the subject/header intent against the message body intent. Its output appears as `AI semantic evidence`.
- Real model slot: replace or augment the local semantic layer with an embedding classifier or small transformer that classifies sender fit, content intent, and header/body mismatch.

Confusable patterns now covered include:

- `m` versus `rn`
- `n` versus `ri`
- `w` versus `vv`
- `l`, `I`, `1`, `|`, and `!`
- `o`, `0`, Greek omicron, and Cyrillic o
- `a`, `e`, `c`, `p`, `x`, `y` versus Cyrillic or Greek lookalikes
- `s` versus `5` or `$`
- `cl` versus `d`
- inserted dots/hyphens, doubled letters, missing letters through skeleton/edit-distance comparison
- punycode domains such as `xn--...`
- mixed-script domain labels

## 3. Sender relationship and anomaly AI

- Built in: `src/service_worker.js` stores sender memory and sender profiles.
- It flags new senders with links/attachments, previously suspicious senders, and new addresses on familiar domains.
- This supports the email framework's "seen before -> break" path while keeping risky sender behavior visible.

## 4. Website DOM and form classifier

- Built in: `src/content_web.js` collects form fields, hidden inputs, iframes, external link hosts, and script hosts.
- Built in: `src/risk_engine.js` now turns website data into structured features and exact evidence instead of broad phishing rules.
- Built in: exact evidence catches visual/domain impersonation, punycode, mixed scripts, and password forms without HTTPS.

## 5. Attachment and document model

- Built in: `src/content_documents.js` sends link text, external host counts, script hosts, iframe counts, and attachment-like names.
- Built in: `src/risk_engine.js` now scores exact document/download object evidence such as executable files, active-content document types, visual impersonation in filenames, and linked-domain impersonation.
- Production slot: parse PDFs/DOCX/XLSX in a sandboxed backend or local companion app, then pass extracted text, URLs, and macro/script metadata to `SCAN_SURFACE`.

## 6. AI risk report generator

- Built in: `src/service_worker.js` generates an evidence-bound `report.ai` object from findings only.
- Built in: it can optionally call `http://127.0.0.1:8766/analyze` using redacted features, finding IDs, categories, and host metadata, not full email/document text.
- The UI displays the summary, impact, and confidence.

Expected optional local AI response:

```json
{
  "model": "local-veyra-ai",
  "findings": [
    {
      "id": "model-extra-signal",
      "severity": "medium",
      "points": 12,
      "category": "AI model",
      "where": "example.com",
      "detail": "Reason from model evidence.",
      "advice": "Suggested user action."
    }
  ],
  "narrative": {
    "summary": "Short evidence-bound summary.",
    "possibleImpact": "What could happen.",
    "advice": "What the user should do.",
    "confidence": "medium",
    "evidenceIds": ["finding-id"]
  }
}
```

## 7. User feedback loop

- Built in: website reports show Safe, Phishing, and Too strict feedback buttons.
- Built in: `src/service_worker.js` stores feedback locally in `veyraFeedback`.
- Built in: the popup shows the number of labels collected.
- Training use: export stored labels later with finding IDs, score, surface, and user label. Do not include raw email or document text unless the user explicitly opts in.
