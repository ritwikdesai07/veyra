from __future__ import annotations

import argparse
import csv
import random
from pathlib import Path

from spoof_features import CONFUSABLE_MAP, INVISIBLE_OR_CONTROL, SUBSTRING_CONFUSABLES

DEFAULT_DOMAINS = [
    "google.com",
    "microsoft.com",
    "paypal.com",
    "apple.com",
    "amazon.com",
    "github.com",
    "docusign.com",
    "dropbox.com",
    "chase.com",
    "wellsfargo.com",
    "netflix.com",
    "adobe.com",
    "bankofamerica.com",
    "example.com",
]

REVERSE_CONFUSABLES: dict[str, list[str]] = {}
for fake, real in CONFUSABLE_MAP.items():
    REVERSE_CONFUSABLES.setdefault(real, []).append(fake)

SUBSTRING_REVERSE = {target: source for source, target in SUBSTRING_CONFUSABLES.items()}
EMAIL_PREFIXES = ["support", "security", "billing", "admin", "help", "notice", "updates"]


def read_domains(path: Path | None) -> list[str]:
    if path is None:
        return DEFAULT_DOMAINS
    domains = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            domain = line.strip().lower()
            if domain and not domain.startswith("#"):
                domains.append(domain)
    return domains or DEFAULT_DOMAINS


def replace_one_character(value: str, rng: random.Random) -> str:
    candidates = [(index, char) for index, char in enumerate(value.lower()) if char in REVERSE_CONFUSABLES]
    if not candidates:
        return value
    index, char = rng.choice(candidates)
    replacement = rng.choice(REVERSE_CONFUSABLES[char])
    return value[:index] + replacement + value[index + 1:]


def replace_substring(value: str, rng: random.Random) -> str:
    candidates = [(target, source) for target, source in SUBSTRING_REVERSE.items() if target in value.lower()]
    if not candidates:
        return replace_one_character(value, rng)
    target, source = rng.choice(candidates)
    index = value.lower().find(target)
    return value[:index] + source + value[index + len(target):]


def insert_invisible(value: str, rng: random.Random) -> str:
    invisible = rng.choice(list(INVISIBLE_OR_CONTROL.keys()))
    index = rng.randrange(0, len(value) + 1)
    return value[:index] + invisible + value[index:]


def mutate_domain(domain: str, rng: random.Random) -> str:
    mutator = rng.choice([replace_one_character, replace_substring, insert_invisible])
    mutated = mutator(domain, rng)
    if mutated == domain:
        mutated = replace_one_character(domain, rng)
    return mutated


def as_email(domain: str, rng: random.Random) -> str:
    return f"{rng.choice(EMAIL_PREFIXES)}@{domain}"


def as_url(domain: str, rng: random.Random) -> str:
    prefix = rng.choice(["", "https://", "https://www."])
    path = rng.choice(["", "/login", "/security", "/invoice", "/verify"])
    return f"{prefix}{domain}{path}"


def as_body(domain: str, rng: random.Random) -> str:
    return rng.choice([
        f"Please verify your account at {domain} before it is suspended.",
        f"Open the secure document from {domain} and sign in to continue.",
        f"Your payment details must be updated at {domain}.",
    ])


def generate_rows(domains: list[str], variants_per_domain: int, seed: int) -> list[dict[str, object]]:
    rng = random.Random(seed)
    rows: list[dict[str, object]] = []
    for domain in domains:
        safe_values = [domain, as_email(domain, rng), as_url(domain, rng)]
        for value in safe_values:
            rows.append({"input": value, "label": 0, "source_domain": domain, "kind": "safe"})

        for _ in range(variants_per_domain):
            spoofed = mutate_domain(domain, rng)
            kind = rng.choice(["domain", "email", "url", "body"])
            if kind == "email":
                value = as_email(spoofed, rng)
            elif kind == "url":
                value = as_url(spoofed, rng)
            elif kind == "body":
                value = as_body(spoofed, rng)
            else:
                value = spoofed
            rows.append({"input": value, "label": 1, "source_domain": domain, "kind": kind})
    rng.shuffle(rows)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate synthetic spoofing examples for Veyra.")
    parser.add_argument("--domains", type=Path, default=None, help="Optional newline-separated legitimate domains.")
    parser.add_argument("--out", type=Path, default=Path("ml") / "data" / "spoof_training.csv")
    parser.add_argument("--variants-per-domain", type=int, default=8)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    domains = read_domains(args.domains)
    rows = generate_rows(domains, args.variants_per_domain, args.seed)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["input", "label", "source_domain", "kind"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} rows to {args.out}")


if __name__ == "__main__":
    main()
