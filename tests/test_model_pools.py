import json
import sys

sys.path.insert(0, '.')


def test_get_pool_for_implementer_has_real_free_models():
    from config.model_pools import get_pool, next_model
    pool = get_pool("implementer")
    assert pool["enabled"] is True
    assert pool["models"] == ["opencode/hy3-free", "opencode/mimo-v2.5-free"]
    assert next_model("implementer", "opencode/hy3-free") == "opencode/mimo-v2.5-free"


def test_primary_nla_is_not_silently_replaced():
    from config.model_pools import get_pool, next_model
    pool = get_pool("nla")
    assert pool["enabled"] is False
    assert next_model("nla", "opencode/hy3-free") is None


def test_every_enabled_pool_is_bounded():
    with open("config/model-pools.json", "r") as f:
        roles = json.load(f)["roles"]
    for role, pool in roles.items():
        if pool["enabled"]:
            assert len(pool["models"]) == 2, role
            assert pool["max_failovers"] == 1, role
            assert pool["idle_timeout_ms"] > 0, role
