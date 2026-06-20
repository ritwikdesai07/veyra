from __future__ import annotations

import argparse
import json
import pickle
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert an old pickled XGBoost classifier into a portable JSON model."
    )
    parser.add_argument("pickle_path", type=Path)
    parser.add_argument("--out", type=Path, default=Path("ml") / "xgboost_url_model.json")
    parser.add_argument("--metadata", type=Path, default=Path("ml") / "xgboost_url_model.metadata.json")
    args = parser.parse_args()

    with args.pickle_path.open("rb") as handle:
        model = pickle.load(handle)

    if not hasattr(model, "save_model"):
        raise TypeError("Loaded object does not expose save_model().")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    model.save_model(str(args.out))

    booster = getattr(model, "get_booster", lambda: None)()
    metadata = {
        "classes": [str(value) for value in getattr(model, "classes_", [])],
        "feature_names": getattr(booster, "feature_names", None) or getattr(model, "feature_names_in_", None),
        "feature_types": getattr(booster, "feature_types", None),
        "converted_from": str(args.pickle_path),
    }
    args.metadata.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"Wrote {args.out}")
    print(f"Wrote {args.metadata}")


if __name__ == "__main__":
    main()
