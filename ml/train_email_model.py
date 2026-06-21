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
    "subject_body_overlap",
    "sensitive_topic_conflict",
]

STOP_TOPIC_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do", "does",
    "for", "from", "has", "have", "hey", "hi", "i", "in", "is", "it", "just",
    "know", "let", "me", "my", "of", "on", "or", "our", "please", "re", "soon",
    "that", "the", "this", "to", "was", "we", "with", "you", "your",
}

TOPIC_CATEGORY_KEYWORDS = {
    "security": {"alert", "breach", "compromise", "danger", "fraud", "hack", "malicious", "malware", "phishing", "risk", "scam", "security", "spoof", "suspicious", "threat", "virus"},
    "finance": {"account", "bank", "billing", "card", "charge", "deposit", "invoice", "money", "pay", "payment", "payroll", "refund", "subscription", "tax", "wire"},
    "credentials": {"2fa", "code", "credential", "login", "otp", "password", "reset", "signin", "verify"},
    "work": {"agenda", "calendar", "client", "contract", "deadline", "document", "meeting", "memo", "project", "proposal", "report", "schedule", "task"},
    "social": {"birthday", "coffee", "dinner", "family", "free", "hang", "lunch", "party", "plan", "weekend"},
    "food": {"cream", "dessert", "food", "ice", "sprinkle", "sprinkles", "summer", "treat", "vanilla"},
    "promo": {"coupon", "deal", "discount", "offer", "promo", "sale"},
}

SENSITIVE_TOPIC_CATEGORIES = {"security", "finance", "credentials"}


def topic_keywords(value: str) -> set[str]:
    words = (
        str(value or "")
        .lower()
        .replace("https://", " ")
        .replace("http://", " ")
    )
    for char in ",.;:!?()[]{}<>\"'":
        words = words.replace(char, " ")
    return {
        word.strip()
        for word in words.split()
        if len(word.strip()) >= 3 and word.strip() not in STOP_TOPIC_WORDS
    }


def topic_categories(words: set[str]) -> set[str]:
    categories: set[str] = set()
    for category, keywords in TOPIC_CATEGORY_KEYWORDS.items():
        if any(word == keyword or word.startswith(keyword) or keyword.startswith(word) for word in words for keyword in keywords):
            categories.add(category)
    return categories


def derived_topic_features(subject: str, body: str) -> tuple[float, int]:
    subject_words = topic_keywords(subject)
    body_words = topic_keywords(body)
    if not subject_words or not body_words:
        return 0.0, 0

    overlap = len(subject_words & body_words) / max(1, len(subject_words | body_words))
    subject_categories = topic_categories(subject_words)
    body_categories = topic_categories(body_words)
    shared_categories = subject_categories & body_categories
    sensitive_conflict = int(
        not shared_categories
        and (
            bool(subject_categories & SENSITIVE_TOPIC_CATEGORIES)
            or bool(body_categories & SENSITIVE_TOPIC_CATEGORIES)
        )
    )
    return float(overlap), sensitive_conflict


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

    derived = frame.apply(lambda row: derived_topic_features(row["subject"], row["body"]), axis=1)
    frame["subject_body_overlap"] = [value[0] for value in derived]
    frame["sensitive_topic_conflict"] = [value[1] for value in derived]

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
