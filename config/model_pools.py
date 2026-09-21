import json
import os
import re

DEFAULT_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "model-pools.json")
_ROLE_ID = re.compile(r"^[a-z][a-z0-9_-]*$")
_BINDING_PART = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")


def config_path(explicit_path=None):
    override = explicit_path or os.environ.get("NLA_MODEL_POOLS_PATH")
    return os.path.abspath(os.path.expanduser(override)) if override else DEFAULT_CONFIG_PATH


def load_pools(explicit_path=None):
    path = config_path(explicit_path)
    with open(path, "r", encoding="utf-8") as f:
        parsed = json.load(f)
    validate_pools(parsed, path)
    return parsed


def validate_model_binding(binding, label="model binding"):
    if not isinstance(binding, str) or binding != binding.strip() or len(binding) > 256:
        raise ValueError(f"{label} must be a trimmed provider/model identifier")
    parts = binding.split("/")
    if len(parts) < 2 or any(not _BINDING_PART.fullmatch(part) for part in parts) or parts[0] == parts[1]:
        raise ValueError(f"{label} must be provider/model and must not repeat its provider prefix: {binding!r}")
    return binding


def validate_pools(parsed, source="model pool file"):
    if not isinstance(parsed, dict) or not isinstance(parsed.get("roles"), dict):
        raise ValueError(f"model pool file has no valid roles object: {source}")
    for role, pool in parsed["roles"].items():
        if not isinstance(role, str) or not _ROLE_ID.fullmatch(role):
            raise ValueError(f"invalid model-pool role name {role!r} in {source}")
        if not isinstance(pool, dict):
            raise ValueError(f"role {role} must be an object in {source}")
        if "enabled" in pool and not isinstance(pool["enabled"], bool):
            raise ValueError(f"role {role}.enabled must be boolean in {source}")
        models = pool.get("models")
        if not isinstance(models, list) or not models:
            raise ValueError(f"role {role} requires a non-empty models array in {source}")
        seen = set()
        for index, binding in enumerate(models):
            binding = validate_model_binding(binding, f"role {role}.models[{index}]")
            if binding in seen:
                raise ValueError(f"role {role} repeats model binding {binding!r} in {source}")
            seen.add(binding)
    return parsed


def preflight_pools(parsed, available_bindings=None, source="model pool file"):
    validate_pools(parsed, source)
    if available_bindings is None:
        return {"roles": len(parsed["roles"]), "checked_availability": False}
    if not isinstance(available_bindings, list):
        raise ValueError("available model inventory must be an array of provider/model identifiers")
    available = {validate_model_binding(binding, f"available model inventory[{index}]") for index, binding in enumerate(available_bindings)}
    unavailable = [f"{role}:{binding}" for role, pool in parsed["roles"].items() if pool.get("enabled") for binding in pool["models"] if binding not in available]
    if unavailable:
        raise ValueError("enabled model-pool bindings absent from supplied runtime inventory: " + ", ".join(unavailable))
    return {"roles": len(parsed["roles"]), "checked_availability": True}


def get_pool(role):
    return load_pools().get("roles", {}).get(role, {})


def next_model(role, current_model):
    models = get_pool(role).get("models", [])
    try:
        return models[models.index(current_model) + 1]
    except (ValueError, IndexError):
        return None
