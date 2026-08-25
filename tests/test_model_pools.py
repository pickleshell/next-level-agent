import sys, os; sys.path.insert(0, '.')
import json

def test_get_pool_for_implementer():
    from config.model_pools import get_pool
    pool = get_pool("implementer")
    assert pool["default"] == "claude-opus-4-5"
    assert pool["fallback"] == "claude-sonnet-4-5"
    assert pool["manual"] is False
