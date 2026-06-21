# Veyra Model Roadmap

This project should use multiple small models plus deterministic security checks. One giant "phishing AI" is harder to explain, harder to evaluate, and easier to fool.

## 1. URL Phishing Model

Current asset: `XGBoostClassifier.pickle.dat`.

Use it for:

- Website URLs.
- Links inside emails.
- Links inside documents.
- Download source URLs.

Training data needs:

- URL string.
- Final redirected URL.
- Label: benign, phishing, malware, unknown.
- Optional metadata: domain age, domain expiration, registrar, certificate age, ASN, hosting provider, redirect count.

Useful features:

- URL length and path depth.
- IP address host.
- punycode or homograph markers.
- URL shortener.
- brand word in non-official domain.
- hyphenated or lookalike root domain.
- suspicious TLD.
- HTTPS mismatch.
- redirect chain length.
- domain age and expiration.

Recommended models:

- XGBoost or LightGBM for tabular URL/domain features.
- Character-level CNN/Transformer for raw URL strings if you collect enough labeled data.
- Use both: deterministic rules for explanation, model score for probability.

## 2. Email Content Model

Goal: classify the intent and social-engineering style of the email body.

Training data needs:

- Email subject.
- Body text.
- Sender display name and domain.
- Reply-To and Return-Path domains.
- Authentication results when available: SPF, DKIM, DMARC.
- Links and attachment names.
- Label: benign, phishing, business email compromise, credential theft, malware delivery, spam.

Useful labels to add:

- Urgency or pressure.
- Credential request.
- Payment or gift-card request.
- Impersonated brand.
- Internal executive impersonation.
- OAuth consent lure.
- Callback phishing.

Recommended models:

- Start with TF-IDF plus logistic regression or linear SVM for a baseline.
- Move to a small transformer such as DistilBERT for body/subject intent.
- Keep deterministic header/domain checks outside the text model.

Evaluation:

- Measure false negatives separately for credential theft, payment fraud, and malware lures.
- Tune thresholds for high recall on dangerous classes.
- Report precision, recall, F1, ROC-AUC, PR-AUC, and confusion matrix.

## 3. Attachment Content Model

A browser extension alone cannot safely inspect all attachments. Use a sandboxed local companion app or backend.

Training data needs:

- File type and MIME type.
- Filename.
- Extracted text from PDF/Office files.
- Embedded URLs.
- Macro presence.
- JavaScript presence.
- Archive contents.
- Static malware scan results.
- Detonation/sandbox behavior if available.
- Label: benign, phishing document, malware dropper, macro malware, unknown.

Extraction pipeline:

- PDF: extract text, links, JavaScript actions, embedded files.
- Office: extract text, links, macros, external relationships.
- Archives: list contained files, nested extension patterns.
- HTML/SVG: extract scripts, forms, links, redirects.

Recommended models:

- Rule-based high-risk gate for executable, macro, double-extension, and embedded-script findings.
- XGBoost/LightGBM on static file features.
- Text classifier on extracted document text.
- Malware sandbox model only after you have safe detonation infrastructure.

## 4. Website Pattern Model

Goal: detect fake login pages, brand impersonation, data theft, and suspicious page behavior.

Training data needs:

- URL and domain metadata.
- Page title and visible text.
- Form fields and form actions.
- Link graph and redirect chain.
- Screenshot or DOM snapshot.
- Detected brand.
- Label: benign, phishing, fake login, malware, scam, unknown.

Useful features:

- Password form present.
- Form submits to a different domain.
- Brand name in title/body but not official domain.
- Many hidden inputs.
- Suspicious iframe.
- Clipboard/download prompts.
- New domain with login form.
- Similar visual layout to a known brand login page.

Recommended models:

- XGBoost for DOM/form/domain features.
- OCR plus visual similarity for fake login pages.
- Lightweight text classifier for page content.
- Safe Browsing or reputation feed as an external signal.

## 5. Spoofing-Specific Model

Spoofing should not be only text classification. It is identity alignment.

Signals:

- Display name claims a brand, sender domain does not match.
- Reply-To domain differs from From domain.
- Return-Path domain differs from From domain.
- SPF/DKIM/DMARC failed or missing.
- Lookalike domain distance from trusted brands.
- Brand logo or name appears on page but domain is not official.
- Visible link text differs from actual href.

Recommended approach:

- Use deterministic checks for identity alignment.
- Train a model only to rank ambiguous cases.
- Keep the report evidence-based so users see exactly what identity failed.

## Production Training Loop

1. Collect labeled examples with consent.
2. Redact secrets and private user data.
3. Split by time and domain so the model cannot memorize old campaigns.
4. Train baseline rules and baseline ML.
5. Evaluate against recent phishing campaigns.
6. Calibrate probabilities.
7. Use conservative thresholds in the browser.
8. Log only minimal telemetry: model version, score bucket, finding ids, user decision.
9. Review false positives and false negatives weekly.
10. Ship model updates with rollback.

## Privacy Guardrails

- Do local inference when possible.
- Never use email/document content for ad targeting.
- Redact passwords, tokens, OTPs, private keys, and personal identifiers before cloud processing.
- Store raw examples only with explicit consent.
- Keep audit logs for model decisions without storing full private content.
