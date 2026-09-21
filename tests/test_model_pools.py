import json
import pytest
from config.model_pools import get_pool, load_pools, next_model, preflight_pools, validate_pools

EXPECTED = {role: pool["models"] for role, pool in json.load(open("config/model-pools.json"))["roles"].items()}

def test_canonical_default_roles(monkeypatch):
    monkeypatch.delenv("NLA_MODEL_POOLS_PATH", raising=False)
    for role, models in EXPECTED.items():
        assert get_pool(role)["models"] == models
        assert next_model(role, models[-1]) is None
        if len(models) > 1:
            assert next_model(role, models[0]) == models[1]
    assert get_pool("nla")["enabled"] is False

def test_model_pool_override_replaces_default(monkeypatch, tmp_path):
    override = tmp_path / "local-pools.json"
    override.write_text(json.dumps({"roles": {"explorer": {"models": ["fixture/override"]}}}))
    monkeypatch.setenv("NLA_MODEL_POOLS_PATH", str(override))
    assert get_pool("explorer")["models"] == ["fixture/override"]
    assert get_pool("architect") == {}


def test_invalid_override_fails_closed(monkeypatch, tmp_path):
    monkeypatch.setenv("NLA_MODEL_POOLS_PATH", str(tmp_path / "missing.json"))
    with pytest.raises(FileNotFoundError):
        load_pools()


def test_pool_validator_rejects_duplicate_or_repeated_provider_prefix():
    provider = "fixture"
    repeated_provider_binding = "/".join((provider, provider, "model"))
    with pytest.raises(ValueError, match="must not repeat its provider prefix"):
        validate_pools({"roles": {"explorer": {"enabled": True, "models": [repeated_provider_binding]}}})
    with pytest.raises(ValueError, match="repeats model binding"):
        validate_pools({"roles": {"explorer": {"enabled": True, "models": ["provider/model", "provider/model"]}}})


def test_preflight_uses_exact_operator_supplied_inventory():
    pools = {"roles": {"explorer": {"enabled": True, "models": ["provider-a/model-x"]}}}
    with pytest.raises(ValueError, match="absent from supplied runtime inventory"):
        preflight_pools(pools, ["provider-b/model-x"])
    assert preflight_pools(pools, ["provider-a/model-x"]) == {"roles": 1, "checked_availability": True}

def test_profile_and_bounded_defaults(monkeypatch):
    monkeypatch.delenv("NLA_MODEL_POOLS_PATH", raising=False)
    with open("opencode.json") as f:
        profile = json.load(f)
    for role in EXPECTED:
        pool = get_pool(role)
        if pool.get("runtime") == "utility":
            assert pool["request_timeout_ms"] > 0
            model = "ollama/" + pool["models"][0]
        else:
            assert pool["idle_timeout_ms"] > 0 or not pool["enabled"]
            model = pool["models"][0]
        assert profile["agent"][role]["model"] == model
