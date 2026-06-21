from __future__ import annotations

import json
import os
import pickle
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import numpy as np
from flask import Flask, jsonify, request

EXPECTED_FEATURES = [
    "URL_Length",
    "URL_Depth",
    "https_Domain",
    "TinyURL",
    "Prefix/Suffix",
    "Domain_Age",
    "Domain_End",
]

SHORTENERS = {
    "bit.ly",
    "tinyurl.com",
    "t.co",
    "goo.gl",
    "ow.ly",
    "is.gd",
    "rebrand.ly",
    "cutt.ly",
    "lnkd.in",
    "buff.ly",
}

DEFAULT_MODEL_PATH = Path.home() / "Downloads" / "XGBoostClassifier.pickle.dat"
MODEL_PATH = Path(os.environ.get("VEYRA_MODEL_PATH", DEFAULT_MODEL_PATH))
DOMAIN_METADATA_PATH = os.environ.get("VEYRA_DOMAIN_METADATA", "")

app = Flask(__name__)
model: Any = None
feature_names = EXPECTED_FEATURES
domain_metadata: dict[str, dict[str, int]] = {}


def load_domain_metadata() -> dict[str, dict[str, int]]:
    if not DOMAIN_METADATA_PATH:
        return {}
    metadata_path = Path(DOMAIN_METADATA_PATH)
    if not metadata_path.exists():
        return {}
    return json.loads(metadata_path.read_text(encoding="utf-8"))


def normalize_host(host: str) -> str:
    return host.lower().removeprefix("www.")


def root_domain(host: str) -> str:
    parts = normalize_host(host).split(".")
    if len(parts) <= 2:
        return normalize_host(host)
    return ".".join(parts[-2:])


# Matches the JS-side canonicalizeUrlForCheck in risk_engine.js: a path
# segment that is purely numeric, or a long opaque token (hex/base64-ish
# IDs, session tokens), is noise that doesn't change what site the URL
# points to, so it's stripped before scoring.
_NUMERIC_SEGMENT = re.compile(r"^\d+$")
_OPAQUE_TOKEN_SEGMENT = re.compile(r"^[a-z0-9_-]{20,}$", re.IGNORECASE)


def canonicalize_url(url: str) -> str:
    """Cut a URL down to scheme + host (the "first part"), the same way an
    email sender address is reduced to its domain before being checked."""
    parsed = urlparse(url if "://" in url else f"http://{url}")
    host = normalize_host(parsed.netloc.split("@")[-1].split(":")[0])
    scheme = parsed.scheme or "http"
    return f"{scheme}://{host}"


def clean_path_for_features(pathname: str) -> str:
    segments = [part for part in pathname.split("/") if part]
    kept = [part for part in segments if not _NUMERIC_SEGMENT.match(part) and not _OPAQUE_TOKEN_SEGMENT.match(part)]
    return "/" + "/".join(kept) if kept else "/"


def extract_features(url: str) -> dict[str, float]:
    # The model is scored on the canonical (scheme+host) form, matching the
    # JS side, but URL_Depth is still computed from the original path with
    # numeric IDs and opaque tokens stripped out first -- that's real path
    # structure the model was trained on, not noise.
    original_parsed = urlparse(url if "://" in url else f"http://{url}")
    cleaned_path = clean_path_for_features(original_parsed.path)
    depth = len([part for part in cleaned_path.split("/") if part])

    canonical = canonicalize_url(url)
    parsed = urlparse(canonical)
    host = normalize_host(parsed.netloc.split("@")[-1].split(":")[0])
    root = root_domain(host)
    metadata = domain_metadata.get(root, {})

    values = {
        "URL_Length": 1 if len(canonical) >= 54 else 0,
        "URL_Depth": depth,
        "https_Domain": 1 if parsed.scheme == "https" else 0,
        "TinyURL": 1 if host in SHORTENERS else 0,
        "Prefix/Suffix": 1 if "-" in root else 0,
        # Unknown age/expiration are neutral in the local prototype. Provide
        # VEYRA_DOMAIN_METADATA for stronger production-like signals.
        "Domain_Age": int(metadata.get("Domain_Age", metadata.get("domain_age", 0))),
        "Domain_End": int(metadata.get("Domain_End", metadata.get("domain_end", 0))),
    }
    return values


def ordered_vector(features: dict[str, float]) -> list[float]:
    return [float(features.get(name, 0)) for name in feature_names]


def phishing_probability(proba: np.ndarray) -> float:
    classes = list(getattr(model, "classes_", []))
    if not len(classes):
        return float(proba[-1])

    normalized = [str(value).lower() for value in classes]
    if "phishing" in normalized:
        return float(proba[normalized.index("phishing")])
    if "1" in normalized:
        return float(proba[normalized.index("1")])
    return float(proba[-1])


def score_url(url: str) -> dict[str, Any]:
    features = extract_features(url)
    vector = np.array([ordered_vector(features)], dtype=float)
    prediction = model.predict(vector)[0]

    probability = 1.0 if str(prediction).lower() in {"1", "phishing"} else 0.0
    if hasattr(model, "predict_proba"):
        probability = phishing_probability(model.predict_proba(vector)[0])

    return {
        "url": url,
        "predicted_label": prediction.item() if hasattr(prediction, "item") else prediction,
        "phishing_probability": probability,
        "features": features,
    }


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    return response


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "model": str(MODEL_PATH),
        "features": feature_names,
    })


@app.route("/score", methods=["POST", "OPTIONS"])
def score():
    if request.method == "OPTIONS":
        return ("", 204)

    payload = request.get_json(force=True, silent=True) or {}
    urls = payload.get("urls") or []
    if isinstance(urls, str):
        urls = [urls]
    urls = [str(url) for url in urls if str(url).startswith(("http://", "https://"))][:25]

    return jsonify({
        "status": "ok",
        "model": "XGBoostClassifier.pickle.dat",
        "features": feature_names,
        "results": [score_url(url) for url in urls],
    })


def load_model() -> None:
    global model, feature_names, domain_metadata
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Model not found: {MODEL_PATH}")

    domain_metadata = load_domain_metadata()
    try:
        if MODEL_PATH.suffix.lower() in {".json", ".ubj"}:
            import xgboost as xgb

            model = xgb.XGBClassifier()
            model.load_model(str(MODEL_PATH))
        else:
            with MODEL_PATH.open("rb") as handle:
                model = pickle.load(handle)
    except Exception as error:
        message = str(error)
        if "older XGBoost" in message or "serialisation_header" in message or "UnserializeFromBuffer" in message:
            raise RuntimeError(
                "This pickle was created by an older XGBoost serializer. "
                "Convert it to JSON from the original training environment with "
                "ml\\convert_legacy_xgboost.py, then set VEYRA_MODEL_PATH to the JSON file."
            ) from error
        raise

    booster = getattr(model, "get_booster", lambda: None)()
    names = getattr(booster, "feature_names", None) or getattr(model, "feature_names_in_", None)
    if names:
        feature_names = list(names)


if __name__ == "__main__":
    try:
        load_model()
    except ModuleNotFoundError as error:
        missing = error.name or "a required package"
        print(f"Cannot load model because {missing} is not installed.")
        print("Run: python -m pip install -r ml\\requirements.txt")
        raise SystemExit(1)
    except Exception as error:
        print(f"Cannot start Veyra URL model server: {error}")
        raise SystemExit(1)

    app.run(host="127.0.0.1", port=8765, debug=False)
