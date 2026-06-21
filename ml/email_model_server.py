from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import joblib
import pandas as pd
from flask import Flask, jsonify, request

DEFAULT_MODEL_PATH = Path("ml") / "email_model.joblib"
MODEL_PATH = Path(os.environ.get("VEYRA_EMAIL_MODEL_PATH", DEFAULT_MODEL_PATH))

app = Flask(__name__)
bundle: dict[str, Any] | None = None


def as_text_list(value: Any) -> str:
    if isinstance(value, list):
        return " ".join(str(item) for item in value)
    return str(value or "")


def extract_record(payload: dict[str, Any]) -> dict[str, Any]:
    features = payload.get("features") or {}
    email_features = features.get("email") or {}
    links = payload.get("links") or []
    attachments = payload.get("attachments") or []
    finding_ids = payload.get("findingIds") or []

    record = {
        "subject": str(payload.get("title") or payload.get("subject") or ""),
        "body": str(payload.get("text") or ""),
        "sender": str(payload.get("sender") or email_features.get("senderHost") or ""),
        "recipients": as_text_list(payload.get("recipients") or []),
        "links": as_text_list(links),
        "attachments": as_text_list(attachments),
        "link_count": len(links),
        "attachment_count": len(attachments),
        "sender_confusable_count": len(email_features.get("senderConfusables") or []),
        "domain_mismatch_count": sum(1 for item in finding_ids if "mismatch" in str(item)),
        "header_body_mismatch": 1 if "header-content-intent-mismatch" in finding_ids else 0,
    }
    record["combined_text"] = (
        "subject: " + record["subject"]
        + "\nbody: " + record["body"]
        + "\nsender: " + record["sender"]
        + "\nrecipients: " + record["recipients"]
        + "\nlinks: " + record["links"]
        + "\nattachments: " + record["attachments"]
    )
    return record


def level_for_probability(probability: float, thresholds: dict[str, float]) -> str:
    if probability >= float(thresholds.get("dangerous", 0.72)):
        return "dangerous"
    if probability >= float(thresholds.get("moderate", 0.45)):
        return "moderate"
    return "safe"


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


@app.route("/analyze", methods=["POST", "OPTIONS"])
def analyze():
    if request.method == "OPTIONS":
        return ("", 204)
    if bundle is None:
        return jsonify({"status": "unavailable", "error": "email model not loaded"}), 503

    payload = request.get_json(force=True, silent=True) or {}
    model = bundle["model"]
    thresholds = bundle.get("thresholds") or {}
    record = extract_record(payload)
    probability = float(model.predict_proba(pd.DataFrame([record]))[0][1])
    level = level_for_probability(probability, thresholds)

    findings = []
    if level != "safe":
        points = 24 if level == "dangerous" else 15
        findings.append({
            "id": "email-ml-phishing-score",
            "severity": "high" if level == "dangerous" else "medium",
            "points": points,
            "category": "AI model",
            "where": record["sender"] or "Email content",
            "detail": f"Email ML model estimated {round(probability * 100)}% phishing probability.",
            "advice": "Verify sender identity and the requested action outside this message.",
        })

    return jsonify({
        "status": "ok",
        "model": "tfidf-logistic-regression-email-v1",
        "probability": probability,
        "level": level,
        "findings": findings,
        "narrative": {
            "summary": f"Email ML model estimated {round(probability * 100)}% phishing probability.",
            "possibleImpact": "A risky email can lead to credential theft, payment fraud, malware, or data exposure.",
            "advice": "Use the exact evidence list first, then verify the sender through a trusted channel.",
            "confidence": "medium" if level != "safe" else "low",
            "evidenceIds": ["email-ml-phishing-score"] if findings else [],
        },
    })


def load_model() -> None:
    global bundle
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Email model not found: {MODEL_PATH}")
    bundle = joblib.load(MODEL_PATH)


if __name__ == "__main__":
    try:
        load_model()
    except Exception as error:
        print(f"Cannot start Veyra email model server: {error}")
        print("Train one first: python ml\\train_email_model.py --data ml\\data\\email_training.csv")
        raise SystemExit(1)

    app.run(host="127.0.0.1", port=8766, debug=False)
