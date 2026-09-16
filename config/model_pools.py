import json
import os

DEFAULT_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "model-pools.json")


def config_path(explicit_path=None):
    override = explicit_path or os.environ.get("NLA_MODEL_POOLS_PATH")
    return os.path.abspath(os.path.expanduser(override)) if override else DEFAULT_CONFIG_PATH


def load_pools(explicit_path=None):
    path = config_path(explicit_path)
    with open(path, "r", encoding="utf-8") as f:
        parsed = json.load(f)
    if not isinstance(parsed, dict) or not isinstance(parsed.get("roles"), dict):
        raise ValueError(f"model pool file has no valid roles object: {path}")
    return parsed


def get_pool(role):
    return load_pools().get("roles", {}).get(role, {})


def next_model(role, current_model):
    models = get_pool(role).get("models", [])
    try:
        return models[models.index(current_model) + 1]
    except (ValueError, IndexError):
        return None
