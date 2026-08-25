import os, json

def save_checkpoint(data):
    path = ".checkpoints/temp.json"
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f)
    return path

def load_checkpoint(path):
    with open(path) as f:
        return json.load(f)
