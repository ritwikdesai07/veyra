# Veyra Local ML Models

This folder wires local ML models into Veyra.

## Email model

The first trainable model is a TF-IDF + calibrated logistic regression email classifier. It uses:

- subject
- body text
- sender
- visible recipients
- links
- attachment names
- exact-feature counts from Veyra
- subject/body keyword overlap
- sensitive topic-conflict signals, such as a security-themed subject with an unrelated casual body

Train it:

```powershell
python -m pip install -r ml\requirements.txt
python ml\train_email_model.py --data ml\data\email_training.csv
```

Run the local email model server:

```powershell
python ml\email_model_server.py
```

The Gmail extension calls this server at `http://127.0.0.1:8766/analyze`.
Keep it running while testing Gmail scans. The current model was trained with
subject/body topic-mismatch examples so cases like a security-themed subject
with an unrelated casual body can receive a calibrated ML risk score instead of
a fixed rule score.

The server listens at:

- `GET http://127.0.0.1:8766/health`
- `POST http://127.0.0.1:8766/analyze`

Veyra already calls this endpoint from the extension service worker. Because it is localhost-only, the prototype can send email text to this local process for scoring. Do not point this endpoint at a cloud server unless you add consent, redaction, retention limits, and a privacy review.

The included `ml\data\email_training.csv` is still a small demo dataset, now with 35 rows. It includes safe social/work examples, credential phishing examples, spoofed sender/link examples, and subject/body mismatch examples. Replace it with a real labeled dataset before trusting the model.

Current sanity-check behavior after training:

- `this is a malicious email` + an ice-cream/sprinkles body scores around `82%` phishing probability.
- `Summer plans` + an ice-cream/sprinkles body stays low.
- `Project meeting` + a meeting body stays low.
- Credential phishing with a spoofed sender scores high.

## Visual spoofing detector

This model is for emails, domains, URLs, and email body text that may contain visual impersonation. It returns:

- binary label: `spoof` or `not-spoof`
- probability from `0` to `1`
- exact flagged characters/substrings with positions

Generate synthetic training data:

```powershell
python ml\generate_spoof_data.py --out ml\data\spoof_training.csv
```

Train the Random Forest detector:

```powershell
python ml\train_spoof_detector.py --data ml\data\spoof_training.csv
```

Try it from the command line:

```powershell
python ml\spoof_cli.py "supp0rt@paypa1.com"
python ml\spoof_cli.py "https://rnicrosoft.com/login"
python ml\spoof_cli.py "google.com"
```

Run it as a local server for the extension:

```powershell
python ml\spoof_model_server.py
```

The server listens at:

- `GET http://127.0.0.1:8767/health`
- `POST http://127.0.0.1:8767/score` with `{ "inputs": ["supp0rt@paypa1.com", "https://rnicrosoft.com/login"] }`

When this server is running, Gmail scans send the visible sender address and link destinations to the model. Veyra then adds `ML spoof model` findings to the same report used by the Gmail risk bar and tooltip/details.

The beginner version uses only `scikit-learn`, `pandas`, and `numpy` for the model. The exact flagging logic is deterministic so users can see which characters triggered suspicion.

## URL model

This folder also wires the downloaded `XGBoostClassifier.pickle.dat` into Veyra as an optional local URL classifier.

The Chrome extension cannot run a Python pickle directly. Instead, this local Flask server loads the model and exposes:

- `GET /health`
- `POST /score` with `{ "urls": ["https://example.com"] }`

## Setup

From the project root:

```powershell
python -m pip install -r ml\requirements.txt
python ml\url_model_server.py
```

By default, the server tries to load:

```text
C:\Users\ritwi_m2ofaxd\Downloads\XGBoostClassifier.pickle.dat
```

To override the path:

```powershell
$env:VEYRA_MODEL_PATH="C:\path\to\XGBoostClassifier.pickle.dat"
python ml\url_model_server.py
```

Then reload the extension from `chrome://extensions`.

## Legacy Pickle Compatibility

The supplied pickle appears to have been created by an older XGBoost serializer. Newer XGBoost versions may refuse to load it with an error about `older XGBoost` or `serialisation_header`.

The durable fix is to open the pickle in the original training environment, or an environment with the same old XGBoost version, and export it to JSON:

```powershell
python ml\convert_legacy_xgboost.py C:\Users\ritwi_m2ofaxd\Downloads\XGBoostClassifier.pickle.dat --out ml\xgboost_url_model.json
```

Then point Veyra to the converted model:

```powershell
$env:VEYRA_MODEL_PATH="C:\Users\ritwi_m2ofaxd\OneDrive\Documents\Coding\Njx Hackathon\ml\xgboost_url_model.json"
python ml\url_model_server.py
```

## Feature Contract

The model file advertises these features:

- `URL_Length`
- `URL_Depth`
- `https_Domain`
- `TinyURL`
- `Prefix/Suffix`
- `Domain_Age`
- `Domain_End`

The server currently extracts URL structure locally. Domain age and expiration are treated as neutral unknown values unless you provide metadata through `VEYRA_DOMAIN_METADATA`.

Example metadata JSON:

```json
{
  "example.com": {
    "Domain_Age": 0,
    "Domain_End": 0
  }
}
```

## Extension Behavior

If the server is running, Veyra adds an `ML URL model` finding when the XGBoost model predicts a suspicious URL. If the server is not running, Veyra keeps the extracted URL features but does not add a URL-model finding.
