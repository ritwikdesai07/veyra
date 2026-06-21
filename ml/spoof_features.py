from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable

import pandas as pd

CONFUSABLE_MAP = {
    "0": "o",
    "1": "l",
    "3": "e",
    "4": "a",
    "5": "s",
    "7": "t",
    "8": "b",
    "а": "a",
    "е": "e",
    "о": "o",
    "р": "p",
    "с": "c",
    "у": "y",
    "х": "x",
    "і": "i",
    "ν": "v",
    "μ": "m",
    "α": "a",
    "ο": "o",
    "ρ": "p",
    "ı": "i",
    "ⅼ": "l",
    "|": "l",
    "!": "l",
}

SUBSTRING_CONFUSABLES = {
    "rn": "m",
    "ri": "n",
    "cl": "d",
    "vv": "w",
}

INVISIBLE_OR_CONTROL = {
    "\u200b": "zero-width space",
    "\u200c": "zero-width non-joiner",
    "\u200d": "zero-width joiner",
    "\ufeff": "zero-width no-break space",
    "\u202a": "left-to-right embedding",
    "\u202b": "right-to-left embedding",
    "\u202d": "left-to-right override",
    "\u202e": "right-to-left override",
    "\u2066": "left-to-right isolate",
    "\u2067": "right-to-left isolate",
    "\u2068": "first strong isolate",
    "\u2069": "pop directional isolate",
}


@dataclass
class Flag:
    start: int
    end: int
    text: str
    reason: str
    replacement: str


def normalize_input(value: str) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^https?://", "", text, flags=re.I)
    text = text.split("/")[0] if "/" in text and " " not in text else text
    return text.lower()


def unicode_block(char: str) -> str:
    code = ord(char)
    if 0x0041 <= code <= 0x007A:
        return "latin"
    if 0x0370 <= code <= 0x03FF:
        return "greek"
    if 0x0400 <= code <= 0x04FF:
        return "cyrillic"
    if char.isdigit():
        return "digit"
    if char in ".-_@:/?&=%+":
        return "url-symbol"
    return unicodedata.name(char, "unknown").split(" ")[0].lower()


def skeleton(value: str) -> str:
    text = normalize_input(value)
    output = "".join(CONFUSABLE_MAP.get(char, char) for char in text)
    for source, target in SUBSTRING_CONFUSABLES.items():
        output = output.replace(source, target)
    return re.sub(r"[^a-z0-9]", "", output)


def edit_distance(left: str, right: str) -> int:
    if left == right:
        return 0
    rows = [[0] * (len(right) + 1) for _ in range(len(left) + 1)]
    for i in range(len(left) + 1):
        rows[i][0] = i
    for j in range(len(right) + 1):
        rows[0][j] = j
    for i in range(1, len(left) + 1):
        for j in range(1, len(right) + 1):
            rows[i][j] = min(
                rows[i - 1][j] + 1,
                rows[i][j - 1] + 1,
                rows[i - 1][j - 1] + (left[i - 1] != right[j - 1]),
            )
    return rows[-1][-1]


def nearest_distance(value: str, known_good: Iterable[str]) -> int:
    value_skeleton = skeleton(value)
    distances = [edit_distance(value_skeleton, skeleton(item)) for item in known_good if item]
    return min(distances) if distances else len(value_skeleton)


def flag_suspicious_parts(value: str) -> list[dict[str, object]]:
    text = str(value or "")
    lowered = text.lower()
    flags: list[Flag] = []

    for index, char in enumerate(text):
        replacement = CONFUSABLE_MAP.get(char) or CONFUSABLE_MAP.get(char.lower())
        if replacement and char.lower() != replacement:
            flags.append(Flag(index, index + 1, char, "confusable character", replacement))
        if char in INVISIBLE_OR_CONTROL:
            flags.append(Flag(index, index + 1, char, INVISIBLE_OR_CONTROL[char], "remove"))

    for source, replacement in SUBSTRING_CONFUSABLES.items():
        start = lowered.find(source)
        while start != -1:
            flags.append(Flag(start, start + len(source), text[start:start + len(source)], "confusable substring", replacement))
            start = lowered.find(source, start + 1)

    return [flag.__dict__ for flag in sorted(flags, key=lambda item: (item.start, item.end))]


def extract_features(value: str, known_good: Iterable[str]) -> dict[str, float]:
    text = normalize_input(value)
    flags = flag_suspicious_parts(value)
    blocks = [unicode_block(char) for char in text if char.strip()]
    block_set = set(blocks)
    ascii_count = sum(1 for char in text if ord(char) < 128)
    non_ascii_count = max(0, len(text) - ascii_count)
    alpha_count = sum(1 for char in text if char.isalpha())
    digit_count = sum(1 for char in text if char.isdigit())
    symbol_count = sum(1 for char in text if not char.isalnum())
    length = max(1, len(text))

    return {
        "length": float(len(text)),
        "log_length": math.log1p(len(text)),
        "unicode_block_count": float(len(block_set)),
        "non_ascii_ratio": non_ascii_count / length,
        "digit_ratio": digit_count / length,
        "symbol_ratio": symbol_count / length,
        "alpha_ratio": alpha_count / length,
        "confusable_char_count": float(sum(1 for flag in flags if flag["reason"] == "confusable character")),
        "confusable_substring_count": float(sum(1 for flag in flags if flag["reason"] == "confusable substring")),
        "has_invisible_chars": float(any(flag["replacement"] == "remove" for flag in flags)),
        "has_rtl": float(any("right-to-left" in str(flag["reason"]) for flag in flags)),
        "mixed_script": float("latin" in block_set and len(block_set - {"digit", "url-symbol", "latin"}) > 0),
        "edit_distance_to_nearest_legit": float(nearest_distance(text, known_good)),
        "skeleton_changed": float(skeleton(text) != re.sub(r"[^a-z0-9]", "", text)),
    }


FEATURE_COLUMNS = [
    "length",
    "log_length",
    "unicode_block_count",
    "non_ascii_ratio",
    "digit_ratio",
    "symbol_ratio",
    "alpha_ratio",
    "confusable_char_count",
    "confusable_substring_count",
    "has_invisible_chars",
    "has_rtl",
    "mixed_script",
    "edit_distance_to_nearest_legit",
    "skeleton_changed",
]


def frame_from_feature_dicts(values: list[dict[str, float]]) -> pd.DataFrame:
    return pd.DataFrame(values)[FEATURE_COLUMNS]


def numeric_features(frame: pd.DataFrame, known_good: list[str]) -> pd.DataFrame:
    rows = [extract_features(value, known_good) for value in frame["input"].astype(str)]
    return frame_from_feature_dicts(rows)


def text_values(frame: pd.DataFrame) -> pd.Series:
    return frame["input"].astype(str)
