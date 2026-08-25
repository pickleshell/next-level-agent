import os, json, glob

def load_latest_checkpoint():
    checkpoint_dir = ".checkpoints"
    if not os.path.isdir(checkpoint_dir):
        return None
    files = glob.glob(os.path.join(checkpoint_dir, "*.json"))
    if not files:
        return None
    latest = max(files, key=os.path.getmtime)
    with open(latest, "r") as f:
        return json.load(f)
