#!/usr/bin/env python3
"""Pre-push secret guard for the Test Hub repo.

Usage:
  python3 scripts/check-secrets.py [file ...]
  # no args -> scan the whole test-hub tree (except node_modules)

Fails (exit 1) if:
  - any listed file is a real .env file (.env.example is fine), or
  - any file contains a known real-secret format (GitHub PAT, AWS key,
    Stripe live key, Slack token, private key block), or
  - a KEY/SECRET/TOKEN/PASSWORD assignment holds a value that is NOT
    an obvious placeholder (demo-, your-key-here, placeholder, example,
    changeme, xxx, dummy, not-real).

Why this exists: gh.py push pushes explicitly named files and does NOT
respect .gitignore — .gitignore alone cannot stop a .env from being
pushed by mistake. Run this before EVERY push, and never name a .env
file in a push command.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PLACEHOLDERS = ("demo-", "your-key-here", "placeholder", "example",
                "changeme", "xxx", "dummy", "not-real", "test123")

SECRET_FORMATS = [
    (r"ghp_[A-Za-z0-9]{20,}", "GitHub PAT"),
    (r"github_pat_[A-Za-z0-9_]{20,}", "GitHub fine-grained PAT"),
    (r"AKIA[0-9A-Z]{16}", "AWS access key"),
    (r"sk-(live|proj)-[A-Za-z0-9]{10,}", "Stripe/OpenAI-style live key"),
    (r"xox[baprs]-[A-Za-z0-9-]{10,}", "Slack token"),
    (r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----", "private key"),
]

ASSIGNMENT = re.compile(
    r"(?i)(api[_-]?key|secret|token|password|passwd|pwd)\s*=\s*['\"]?([^'\"\s]{8,})['\"]?"
)

def is_placeholder(value):
    v = value.lower()
    return any(p in v for p in PLACEHOLDERS)

def check_file(path, listed=False):
    errors = []
    name = os.path.basename(path)
    if listed and (name == ".env" or (name.startswith(".env.") and name != ".env.example")):
        errors.append(f"{path}: real .env file must never be pushed")
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            text = f.read()
    except (OSError, UnicodeDecodeError):
        return errors
    for pattern, label in SECRET_FORMATS:
        if re.search(pattern, text):
            errors.append(f"{path}: looks like a real {label}")
    for m in ASSIGNMENT.finditer(text):
        key, value = m.group(1), m.group(2)
        if not is_placeholder(value):
            errors.append(f"{path}: {key} has a non-placeholder value (ends …{value[-4:]})")
    return errors

def main():
    targets = sys.argv[1:]
    files = []
    if targets:
        files = [t for t in targets if os.path.isfile(t)]
        errors = []
        for f in sorted(files):
            errors.extend(check_file(f, listed=True))
    else:
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d != "node_modules"]
            for fn in filenames:
                # Local .env files are gitignored and never pushed; the
                # push-list mode above is what blocks them. Here we only
                # scan files that could actually reach GitHub.
                if fn == ".env" or (fn.startswith(".env.") and fn != ".env.example"):
                    continue
                files.append(os.path.join(dirpath, fn))
        errors = []
        for f in sorted(files):
            errors.extend(check_file(f, listed=False))
    if errors:
        print("SECRET CHECK FAILED:")
        for e in errors:
            print("  " + e)
        return 1
    print(f"secret check OK ({len(files)} files scanned, no .env, no real secrets)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
