from __future__ import annotations

import argparse
from pathlib import Path

import joblib
import pandas as pd

from spoof_features import extract_features, flag_suspicious_parts


def load_bundle(path: Path):
    if not path.exists():
        raise FileNotFoundError(f"Model not found: {path}. Train it with ml\\train_spoof_detector.py first.")
    return joblib.load(path)


def predict(value: str, bundle: dict) -> dict[str, object]:
    model = bundle["model"]
    threshold = float(bundle.get("threshold", 0.5))
    known_good = bundle.get("known_good", [])
    probability = float(model.predict_proba(pd.DataFrame([{"input": value}]))[0][1])
    label = int(probability >= threshold)
    return {
        "input": value,
        "label": label,
        "label_text": "spoof" if label else "not-spoof",
        "probability": probability,
        "flags": flag_suspicious_parts(value),
        "features": extract_features(value, known_good),
    }


def print_result(result: dict[str, object]) -> None:
    print(f"Input: {result['input']}")
    print(f"Prediction: {result['label_text']} ({result['label']})")
    print(f"Probability: {float(result['probability']):.3f}")
    print("Flags:")
    flags = result["flags"] or []
    if not flags:
        print("  none")
    else:
        for flag in flags:
            print(
                f"  [{flag['start']}:{flag['end']}] {flag['text']!r} -> {flag['replacement']!r}"
                f" ({flag['reason']})"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Veyra's spoof detector on one input.")
    parser.add_argument("value", nargs="?", help="Email, domain, URL, or email body text to inspect.")
    parser.add_argument("--model", type=Path, default=Path("ml") / "spoof_detector.joblib")
    args = parser.parse_args()

    bundle = load_bundle(args.model)
    if args.value:
        print_result(predict(args.value, bundle))
        return

    print("Type an email, domain, URL, or email body. Press Ctrl+C to exit.")
    while True:
        try:
            value = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if value:
            print_result(predict(value, bundle))


if __name__ == "__main__":
    main()
