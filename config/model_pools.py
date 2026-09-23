import json
import math
import os
import re
from datetime import datetime

DEFAULT_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "model-pools.json")
_ROLE_ID = re.compile(r"^[a-z][a-z0-9_-]*$")
_BINDING_PART = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_SCORE_KEYS = {"coding", "reasoning", "tool_use", "reliability", "latency"}


def _validate_availability(value, label):
    if value is None or isinstance(value, bool) or (isinstance(value, str) and value in {"always", "available", "never", "unavailable"}):
        return
    if not isinstance(value, dict):
        raise ValueError(f"{label}.availability is invalid")
    if "enabled" in value and not isinstance(value["enabled"], bool):
        raise ValueError(f"{label}.availability.enabled must be boolean")
    if value.get("schedule") not in {None, "always", "windows"}:
        raise ValueError(f"{label}.availability.schedule must be always or windows")
    windows = value.get("windows")
    if windows is None:
        if value.get("schedule") == "windows":
            raise ValueError(f"{label}.availability.windows is required for a scheduled availability")
        return
    if not isinstance(windows, list) or not windows:
        raise ValueError(f"{label}.availability.windows must be a non-empty array")
    for index, window in enumerate(windows):
        if not isinstance(window, dict) or not window.get("start") and not window.get("end"):
            raise ValueError(f"{label}.availability.windows[{index}] must contain start or end")
        try:
            start = datetime.fromisoformat(str(window["start"]).replace("Z", "+00:00")) if window.get("start") else None
            end = datetime.fromisoformat(str(window["end"]).replace("Z", "+00:00")) if window.get("end") else None
        except (ValueError, TypeError) as error:
            raise ValueError(f"{label}.availability.windows[{index}] contains invalid dates") from error
        try:
            if start and end and start > end:
                raise ValueError(f"{label}.availability.windows[{index}] contains an inverted range")
        except TypeError as error:
            raise ValueError(f"{label}.availability.windows[{index}] contains incompatible date zones") from error


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
        if "selection_mode" in pool and pool["selection_mode"] not in {"fallback", "select"}:
            raise ValueError(f"role {role}.selection_mode must be fallback or select in {source}")
        weights = pool.get("selection_weights")
        if weights is not None:
            if not isinstance(weights, dict) or not weights:
                raise ValueError(f"role {role}.selection_weights must be a non-empty object in {source}")
            for key, value in weights.items():
                if key not in _SCORE_KEYS or not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or not 0 <= value <= 10:
                    raise ValueError(f"role {role}.selection_weights.{key} must be a number from 0 to 10 in {source}")
        models = pool.get("models")
        if not isinstance(models, list) or not models:
            raise ValueError(f"role {role} requires a non-empty models array in {source}")
        seen = set()
        for index, binding in enumerate(models):
            binding = validate_model_binding(binding, f"role {role}.models[{index}]")
            if binding in seen:
                raise ValueError(f"role {role} repeats model binding {binding!r} in {source}")
            seen.add(binding)
        facts = pool.get("model_facts", pool.get("model_metadata"))
        if facts is not None:
            if not isinstance(facts, dict):
                raise ValueError(f"role {role}.model_facts must be an object in {source}")
            for binding, record in facts.items():
                if binding not in seen:
                    raise ValueError(f"role {role}.model_facts contains unlisted binding {binding!r} in {source}")
                if not isinstance(record, dict):
                    raise ValueError(f"role {role}.model_facts.{binding} must be an object in {source}")
                if record.get("id", binding) != binding:
                    raise ValueError(f"role {role}.model_facts.{binding}.id must match its binding in {source}")
                if "status" in record and record["status"] not in ("enabled", "disabled"):
                    raise ValueError(f"role {role}.model_facts.{binding}.status must be enabled or disabled in {source}")
                if "context_window" in record and (not isinstance(record["context_window"], int) or isinstance(record["context_window"], bool) or record["context_window"] <= 0):
                    raise ValueError(f"role {role}.model_facts.{binding}.context_window must be a positive integer in {source}")
                for key in ("input_cost", "output_cost"):
                    if key in record and (not isinstance(record[key], (int, float)) or isinstance(record[key], bool) or not math.isfinite(record[key]) or record[key] < 0):
                        raise ValueError(f"role {role}.model_facts.{binding}.{key} must be a non-negative number in {source}")
                _validate_availability(record.get("availability"), f"role {role}.model_facts.{binding}")
    return parsed


def preflight_pools(parsed, available_bindings=None, source="model pool file"):
    validate_pools(parsed, source)
    if available_bindings is None:
        return {"roles": len(parsed["roles"]), "checked_availability": False}
    if not isinstance(available_bindings, list):
        raise ValueError("available model inventory must be an array of provider/model identifiers")
    available = {validate_model_binding(binding, f"available model inventory[{index}]") for index, binding in enumerate(available_bindings)}
    unavailable = [f"{role}:{binding}" for role, pool in parsed["roles"].items() if pool.get("enabled") for binding in pool["models"] if (pool.get("model_facts") or {}).get(binding, {}).get("status") != "disabled" and binding not in available]
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
