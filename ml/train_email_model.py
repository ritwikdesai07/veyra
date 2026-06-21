from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.compose import ColumnTransformer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

TEXT_COLUMNS = ["subject", "body", "sender", "recipients", "links", "attachments"]
NUMERIC_COLUMNS = [
    "link_count",
    "attachment_count",
    "sender_confusable_count",
    "domain_mismatch_count",
    "header_body_mismatch",
]


def normalize_label(value: object) -> int:
    text = str(value or "").strip().lower()
    if text in {"1", "true", "phishing", "phish", "malicious", "dangerous", "spam"}:
        return 1
    if text in {"0", "false", "safe", "benign", "legitimate", "ham"}:
        return 0
    raise ValueError(f"Unsupported label: {value!r}")


def ensure_columns(frame: pd.DataFrame) -> pd.DataFrame:
    missing = [column for column in ["label", *TEXT_COLUMNS] if column not in frame.columns]
    if missing:
        raise ValueError(f"Dataset is missing required columns: {', '.join(missing)}")

    frame = frame.copy()
    for column in TEXT_COLUMNS:
        frame[column] = frame[column].fillna("").astype(str)
    for column in NUMERIC_COLUMNS:
        if column not in frame.columns:
            frame[column] = 0
        frame[column] = pd.to_numeric(frame[column], errors="coerce").fillna(0)
    frame["label"] = frame["label"].map(normalize_label)
    frame["combined_text"] = (
        "subject: " + frame["subject"]
        + "\nbody: " + frame["body"]
        + "\nsender: " + frame["sender"]
        + "\nrecipients: " + frame["recipients"]
        + "\nlinks: " + frame["links"]
        + "\nattachments: " + frame["attachments"]
    )
    return frame


def build_pipeline() -> Pipeline:
    features = ColumnTransformer(
        transformers=[
            (
                "text",
                TfidfVectorizer(
                    lowercase=True,
                    ngram_range=(1, 2),
                    min_df=1,
                    max_features=60000,
                    strip_accents="unicode",
                ),
                "combined_text",
            ),
            (
                "numeric",
                StandardScaler(),
                NUMERIC_COLUMNS,
            ),
        ],
        remainder="drop",
    )

    classifier = CalibratedClassifierCV(
        estimator=LogisticRegression(
            class_weight="balanced",
            max_iter=1200,
            solver="liblinear",
        ),
        method="sigmoid",
        cv=3,
    )

    return Pipeline([
        ("features", features),
        ("classifier", classifier),
    ])


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the first Veyra email phishing ML model.")
    parser.add_argument("--data", type=Path, default=Path("ml") / "data" / "email_training.csv")
    parser.add_argument("--out", type=Path, default=Path("ml") / "email_model.joblib")
    parser.add_argument("--metrics", type=Path, default=Path("ml") / "email_model.metrics.json")
    parser.add_argument("--test-size", type=float, default=0.2)
    args = parser.parse_args()

    if not args.data.exists():
        raise FileNotFoundError(f"Training dataset not found: {args.data}")

    frame = ensure_columns(pd.read_csv(args.data))
    label_counts = frame["label"].value_counts().to_dict()
    if len(label_counts) < 2:
        raise ValueError("Training data needs at least one safe and one phishing example.")

    stratify = frame["label"] if frame["label"].value_counts().min() >= 2 else None
    train, test = train_test_split(
        frame,
        test_size=args.test_size,
        random_state=42,
        stratify=stratify,
    )

    model = build_pipeline()
    model.fit(train, train["label"])

    predicted = model.predict(test)
    probabilities = model.predict_proba(test)[:, 1]
    metrics = {
        "model": "tfidf-logistic-regression-email-v1",
        "rows": int(len(frame)),
        "train_rows": int(len(train)),
        "test_rows": int(len(test)),
        "label_counts": {str(key): int(value) for key, value in label_counts.items()},
        "classification_report": classification_report(test["label"], predicted, output_dict=True, zero_division=0),
        "confusion_matrix": confusion_matrix(test["label"], predicted).tolist(),
    }
    if len(set(test["label"])) == 2:
        metrics["roc_auc"] = float(roc_auc_score(test["label"], probabilities))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.metrics.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({
        "model": model,
        "text_columns": TEXT_COLUMNS,
        "numeric_columns": NUMERIC_COLUMNS,
        "thresholds": {
            "moderate": 0.45,
            "dangerous": 0.72,
        },
    }, args.out)
    args.metrics.write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    print(f"Wrote {args.out}")
    print(f"Wrote {args.metrics}")
    print(classification_report(test["label"], predicted, zero_division=0))


if __name__ == "__main__":
    main()
