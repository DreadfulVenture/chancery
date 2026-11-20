"""Consolidation: the summarize loops over captured speech.

The hub side claims and summarizes; the client side owns per-session idle
scheduling. Neither fabricates: when the LLM chain exhausts, the group
retries on a later pass.
"""
