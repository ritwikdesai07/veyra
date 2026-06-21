# Veyra Local URL Model

This folder wires the downloaded `XGBoostClassifier.pickle.dat` into Veyra as an optional local URL classifier.

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

If the server is running, Veyra adds an `ML URL model` finding when the XGBoost model predicts a suspicious URL. If the server is not running, the extension silently falls back to its explainable JavaScript rules.
