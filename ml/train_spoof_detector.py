from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.feature_extraction.text import CountVectorizer
from sklearn.metrics import classification_report, confusion_matrix, precision_recall_fscore_support
from sklearn.model_selection import train_test_split
from sklearn.pipeline import FeatureUnion, Pipeline
from sklearn.preprocessing import FunctionTransformer

from spoof_features import FEATURE_COLUMNS, numeric_features, text_values


def build_pipeline(known_good: list[str]) -> Pipeline:
    numeric = Pipeline([
        ("extract", FunctionTransformer(numeric_features, validate=False, kw_args={"known_good": known_good})),
    ])

    ngrams = Pipeline([
        ("select", FunctionTransformer(text_values, validate=False)),
        ("vectorize", CountVectorizer(analyzer="char", ngram_range=(2, 4), min_df=1, max_features=20000)),
    ])

    features = FeatureUnion([
        ("numeric", numeric),
        ("ngrams", ngrams),
    ])

    model = RandomForestClassifier(
        n_estimators=180,
        random_state=42,
        class_weight="balanced",
        min_samples_leaf=1,
        n_jobs=-1,
    )

    pipeline = Pipeline([
        ("features", features),
        ("model", model),
    ])
    pipeline.known_good = known_good
    return pipeline


def main() -> None:
    parser = argparse.ArgumentParser(description="Train Veyra's visual spoofing detector.")
    parser.add_argument("--data", type=Path, default=Path("ml") / "data" / "spoof_training.csv")
    parser.add_argument("--out", type=Path, default=Path("ml") / "spoof_detector.joblib")
    parser.add_argument("--metrics", type=Path, default=Path("ml") / "spoof_detector.metrics.json")
    parser.add_argument("--test-size", type=float, default=0.2)
    args = parser.parse_args()

    if not args.data.exists():
        raise FileNotFoundError(f"Dataset not found: {args.data}. Run ml\\generate_spoof_data.py first.")

    frame = pd.read_csv(args.data)
    if "input" not in frame.columns or "label" not in frame.columns:
        raise ValueError("Dataset must contain input,label columns.")
    frame["input"] = frame["input"].fillna("").astype(str)
    frame["label"] = frame["label"].astype(int)

    known_good = sorted(frame.loc[frame["label"] == 0, "input"].astype(str).unique().tolist())
    train, test = train_test_split(
        frame[["input", "label"]],
        test_size=args.test_size,
        random_state=42,
        stratify=frame["label"],
    )
    model = build_pipeline(known_good)
    model.fit(train[["input"]], train["label"])

    predicted = model.predict(test[["input"]])
    probabilities = model.predict_proba(test[["input"]])[:, 1]
    precision, recall, f1, _ = precision_recall_fscore_support(test["label"], predicted, average="binary", zero_division=0)

    metrics = {
        "model": "random-forest-visual-spoof-detector-v1",
        "rows": int(len(frame)),
        "train_rows": int(len(train)),
        "test_rows": int(len(test)),
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(f1),
        "classification_report": classification_report(test["label"], predicted, output_dict=True, zero_division=0),
        "confusion_matrix": confusion_matrix(test["label"], predicted).tolist(),
        "example_predictions": [
            {
                "input": value,
                "actual": int(actual),
                "predicted": int(pred),
                "probability": float(probability),
            }
            for value, actual, pred, probability in zip(test["input"].head(12), test["label"].head(12), predicted[:12], probabilities[:12])
        ],
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.metrics.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({
        "model": model,
        "known_good": known_good,
        "feature_columns": FEATURE_COLUMNS,
        "threshold": 0.5,
    }, args.out)
    args.metrics.write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    print(f"Wrote {args.out}")
    print(f"Wrote {args.metrics}")
    print(f"Precision={precision:.3f} Recall={recall:.3f} F1={f1:.3f}")


if __name__ == "__main__":
    main()
