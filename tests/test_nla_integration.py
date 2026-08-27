import sys

sys.path.insert(0, '.')

from compact.checkpoint import save_checkpoint, load_checkpoint
from compact.compact import compress_context
from config.model_pools import get_pool, next_model


def test_full_nla_workflow_config():
    data = {"threshold": 50000, "context": "test"}
    path = save_checkpoint(data)
    assert load_checkpoint(path) == data

    result = compress_context({"messages": ["a"], "summary": "compressed"}, threshold=50000)
    assert result["summary"] == "compressed"
    assert result["threshold"] == 50000

    pool = get_pool("implementer")
    assert pool["enabled"] is True
    assert next_model("implementer", pool["models"][0]) == pool["models"][1]
