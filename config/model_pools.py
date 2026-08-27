import json
import os

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "model-pools.json")


def get_pool(role):
    with open(CONFIG_PATH, "r") as f:
        pools = json.load(f)
    return pools.get("roles", {}).get(role, {})


def next_model(role, current_model):
    models = get_pool(role).get("models", [])
    try:
        return models[models.index(current_model) + 1]
    except (ValueError, IndexError):
        return None
