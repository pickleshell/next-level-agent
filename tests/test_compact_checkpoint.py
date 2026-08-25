import sys, os; sys.path.insert(0, '.')
from compact.checkpoint import save_checkpoint, load_checkpoint

def test_checkpoint_save_and_load():
    data = {"threshold": 50000, "context": "test"}
    path = save_checkpoint(data)
    assert path is not None and os.path.exists(path)
    loaded = load_checkpoint(path)
    assert loaded["threshold"] == 50000

from compact.compact import compress_context
from compact.logger import log_event

def test_compress_context_and_log():
    context = {"messages": ["a"] * 10000}
    result = compress_context(context, threshold=50000)
    assert "summary" in result
    assert result["summary"] == "compressed"
    assert result["threshold"] == 50000
    event_result = log_event("compact")
    assert event_result == "compact"
    assert event_result is not None
