"""Cross-cutting helpers with no domain logic and no routes:
- json_store.py : the shared JSON load/dump + the data/ directory
- llm.py        : Anthropic client, streaming create, forced-tool-use + validation loop
- debuglog.py   : best-effort append-only JSONL logs under data/ (e.g. chat_log.jsonl)
"""
