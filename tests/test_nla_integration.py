import sys, os; sys.path.insert(0, '.')

from compact.checkpoint import save_checkpoint, load_checkpoint
from compact.compact import compress_context
from config.model_pools import get_pool

def test_full_nla_workflow():
    # Checkpoint
    data = {"threshold": 50000, "context": "test"}
    path = save_checkpoint(data)
    loaded = load_checkpoint(path)
    assert loaded["threshold"] == 50000

    # Compress (production behavior: preserves input summary or empty)
    result = compress_context({"messages": ["a"], "summary": "compressed"}, threshold=50000)
    assert "summary" in result
    assert result["threshold"] == 50000
    assert result["summary"] == "compressed"

    # Pool
    pool = get_pool("coordinator")
    assert pool.get("default") is not None

    # Integration verification
    assert result["summary"] == "compressed"
    assert loaded == data

def test_fallback_exists():
    from config.model_pools import get_pool
    assert get_pool("reviewer")["fallback"] == "claude-sonnet-4-5"
