import json
import os

DEFAULT_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "model-pools.json")


def config_path():
    override = os.environ.get("NLA_MODEL_POOLS_PATH")
    return os.path.abspath(os.path.expanduser(override)) if override else DEFAULT_CONFIG_PATH


def get_pool(role):
    with open(config_path(), "r") as f:
        pools = json.load(f)
    return pools.get("roles", {}).get(role, {})


def next_model(role, current_model):
    models = get_pool(role).get("models", [])
    try:
        return models[models.index(current_model) + 1]
    except (ValueError, IndexError):
        return None
