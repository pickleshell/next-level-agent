import sys, os; sys.path.insert(0, '.')
from compact.checkpoint import save_checkpoint, load_checkpoint

def test_checkpoint_save_and_load():
    data = {"threshold": 50000, "context": "test"}
    path = save_checkpoint(data)
    assert path is not None and os.path.exists(path)
    loaded = load_checkpoint(path)
    assert loaded["threshold"] == 50000
