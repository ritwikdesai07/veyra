from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import joblib
import pandas as pd
from flask import Flask, jsonify, request

from spoof_features import extract_features, flag_suspicious_parts

DEFAULT_MODEL_PATH = Path("ml") / "spoof_detector.joblib"
MODEL_PATH = Path(os.environ.get("VEYRA_SPOOF_MODEL_PATH", DEFAULT_MODEL_PATH))

app = Flask(__name__)
bundle: dict[str, Any] | None = None


def normalize_inputs(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    return []


def score_one(value: str) -> dict[str, Any]:
    if bundle is None:
        raise RuntimeError("Spoof model not loaded")

    model = bundle["model"]
    threshold = float(bundle.get("threshold", 0.5))
    known_good = bundle.get("known_good", [])
    probability = float(model.predict_proba(pd.DataFrame([{"input": value}]))[0][1])
    label = int(probability >= threshold)
    flags = flag_suspicious_parts(value)

    return {
        "input": value,
        "label": label,
        "label_text": "spoof" if label else "not-spoof",
        "spoof_probability": probability,
        "flags": flags,
        "features": extract_features(value, known_good),
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
        "loaded": bundle is not None,
    })


@app.route("/score", methods=["POST", "OPTIONS"])
def score():
    if request.method == "OPTIONS":
        return ("", 204)
    if bundle is None:
        return jsonify({"status": "unavailable", "error": "spoof model not loaded"}), 503

    payload = request.get_json(force=True, silent=True) or {}
    inputs = normalize_inputs(payload.get("inputs") or payload.get("values") or payload.get("input"))
    inputs = inputs[:50]
    return jsonify({
        "status": "ok",
        "model": "random-forest-visual-spoof-detector-v1",
        "results": [score_one(value) for value in inputs],
    })


def load_model() -> None:
    global bundle
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Spoof model not found: {MODEL_PATH}")
    bundle = joblib.load(MODEL_PATH)


if __name__ == "__main__":
    try:
        load_model()
    except Exception as error:
        print(f"Cannot start Veyra spoof model server: {error}")
        print("Train one first: python ml\\train_spoof_detector.py --data ml\\data\\spoof_training.csv")
        raise SystemExit(1)

    app.run(host="127.0.0.1", port=8767, debug=False)
