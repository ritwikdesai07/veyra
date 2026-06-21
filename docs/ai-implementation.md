# Veyra AI Implementation

This build implements the seven AI/ML layers as local-first extension code with optional local model endpoints.

## 1. URL phishing model

- Built in: `src/service_worker.js` calls `http://127.0.0.1:8765/score` for URL XGBoost scoring.
- Built in: `src/risk_engine.js` now extracts URL feature vectors such as length, depth, HTTPS, shortener use, risky TLD, punycode, brand impersonation, and redirect parameters.
- Real model slot: run `ml/url_model_server.py` or replace `LOCAL_MODEL_ENDPOINT`.

## 2. Email content classifier

- Built in: `src/risk_engine.js` has a local NLP-style intent layer for credential theft, business email compromise, malware delivery, and data access requests.
- The output appears as `AI content intent` findings.
- Real model slot: replace or augment this with an embedding classifier or small text transformer in a backend/local companion app.

## 3. Sender relationship and anomaly AI

- Built in: `src/service_worker.js` stores sender memory and sender profiles.
- It flags new senders with links/attachments, previously suspicious senders, and new addresses on familiar domains.
- This supports the email framework's "seen before -> break" path while keeping risky sender behavior visible.

## 4. Website DOM and form classifier

- Built in: `src/content_web.js` collects form fields, hidden inputs, iframes, external link hosts, and script hosts.
- Built in: `src/risk_engine.js` scores suspicious website patterns such as payment fields outside checkout, secret fields without password inputs, and login pages with many external hosts.

## 5. Attachment and document model

- Built in: `src/content_documents.js` sends link text, external host counts, script hosts, iframe counts, and attachment-like names.
- Built in: `src/risk_engine.js` scores link-heavy documents with credential/urgency language and archive-plus-execution-lure patterns.
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
