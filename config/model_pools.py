import json, os

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "model-pools.json")

def get_pool(role):
    with open(CONFIG_PATH, "r") as f:
        pools = json.load(f)
    return pools.get(role, {})
