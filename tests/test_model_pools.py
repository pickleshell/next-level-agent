import json
import os
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


def test_model_pool_path_can_be_overridden(monkeypatch, tmp_path):
    from config.model_pools import config_path, get_pool
    override = tmp_path / "local-pools.json"
    override.write_text(json.dumps({"roles": {"compactor": {"enabled": True, "models": ["local/test"]}}}))
    monkeypatch.setenv("NLA_MODEL_POOLS_PATH", str(override))
    assert config_path() == os.path.abspath(override)
    assert get_pool("compactor")["models"] == ["local/test"]


def test_every_enabled_pool_is_bounded():
    with open("config/model-pools.json", "r") as f:
        roles = json.load(f)["roles"]
    for role, pool in roles.items():
        if pool["enabled"]:
            assert len(pool["models"]) == 2, role
            assert pool["max_failovers"] == 1, role
            assert pool["idle_timeout_ms"] > 0, role


def test_public_architect_pool_uses_healthy_smoke_tested_default():
    from config.model_pools import get_pool
    pool = get_pool("architect")
    assert pool["models"][0] == "opencode/mimo-v2.5-free"
    assert not any("nvidia/qwen/qwen3-coder-480b-a35b-instruct" == model for model in pool["models"])
    with open("opencode.json", "r") as f:
        profile = json.load(f)
    assert profile["agent"]["architect"]["model"] == pool["models"][0]
