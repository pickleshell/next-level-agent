#!/usr/bin/env bash
# Setup script for OpenCode plugin tests
# Creates an isolated test environment with proper plugin installation
set -euo pipefail

# Get the repository root (two levels up from tests/opencode/)
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Create temp home directory for isolation
export TEST_HOME
TEST_HOME=$(mktemp -d)
export HOME="$TEST_HOME"
export XDG_CONFIG_HOME="$TEST_HOME/.config"
export OPENCODE_CONFIG_DIR="$TEST_HOME/.config/opencode"

# Standard install layout:
#   $OPENCODE_CONFIG_DIR/nla/             ← package root
#   $OPENCODE_CONFIG_DIR/nla/skills/      ← skills dir (../../skills from plugin)
#   $OPENCODE_CONFIG_DIR/nla/.opencode/plugins/next-level-agent.js ← plugin file
#   $OPENCODE_CONFIG_DIR/plugins/next-level-agent.js   ← symlink OpenCode reads

SUPERPOWERS_DIR="$OPENCODE_CONFIG_DIR/nla"
SUPERPOWERS_SKILLS_DIR="$SUPERPOWERS_DIR/skills"
SUPERPOWERS_PLUGIN_FILE="$SUPERPOWERS_DIR/.opencode/plugins/next-level-agent.js"

# Install skills
mkdir -p "$SUPERPOWERS_DIR"
cp -r "$REPO_ROOT/skills" "$SUPERPOWERS_DIR/"
cat > "$SUPERPOWERS_DIR/package.json" <<'EOF'
{
  "private": true,
  "type": "module"
}
EOF
mkdir -p "$SUPERPOWERS_DIR/node_modules/@opencode-ai/plugin"
cat > "$SUPERPOWERS_DIR/node_modules/@opencode-ai/plugin/package.json" <<'EOF'
{
  "name": "@opencode-ai/plugin",
  "private": true,
  "type": "module",
  "exports": "./index.js"
}
EOF
cat > "$SUPERPOWERS_DIR/node_modules/@opencode-ai/plugin/index.js" <<'EOF'
const chain = () => ({ describe: chain, max: chain, optional: chain });
export const tool = (definition) => definition;
tool.schema = { string: chain, enum: () => chain() };
EOF

# Install plugin
mkdir -p "$(dirname "$SUPERPOWERS_PLUGIN_FILE")"
cp -r "$REPO_ROOT/.opencode/plugins/." "$(dirname "$SUPERPOWERS_PLUGIN_FILE")/"
mkdir -p "$SUPERPOWERS_DIR/config"
cp "$REPO_ROOT/config/model-pools.json" "$SUPERPOWERS_DIR/config/model-pools.json"

# Register plugin via symlink (what OpenCode actually reads)
mkdir -p "$OPENCODE_CONFIG_DIR/plugins"
ln -sf "$SUPERPOWERS_PLUGIN_FILE" "$OPENCODE_CONFIG_DIR/plugins/next-level-agent.js"

# Create test skills in different locations for testing

# Personal test skill
mkdir -p "$OPENCODE_CONFIG_DIR/skills/personal-test"
cat > "$OPENCODE_CONFIG_DIR/skills/personal-test/SKILL.md" <<'EOF'
---
name: personal-test
description: Test personal skill for verification
---
# Personal Test Skill

This is a personal skill used for testing.

PERSONAL_SKILL_MARKER_12345
EOF

# Create a project directory for project-level skill tests
mkdir -p "$TEST_HOME/test-project/.opencode/skills/project-test"
cat > "$TEST_HOME/test-project/.opencode/skills/project-test/SKILL.md" <<'EOF'
---
name: project-test
description: Test project skill for verification
---
# Project Test Skill

This is a project skill used for testing.

PROJECT_SKILL_MARKER_67890
EOF

echo "Setup complete: $TEST_HOME"
echo "OPENCODE_CONFIG_DIR:  $OPENCODE_CONFIG_DIR"
echo "Superpowers dir:      $SUPERPOWERS_DIR"
echo "Skills dir:           $SUPERPOWERS_SKILLS_DIR"
echo "Plugin file:          $SUPERPOWERS_PLUGIN_FILE"
echo "Plugin registered at: $OPENCODE_CONFIG_DIR/plugins/next-level-agent.js"
echo "Test project at:      $TEST_HOME/test-project"

# Helper function for cleanup (call from tests or trap)
cleanup_test_env() {
    if [ -n "${TEST_HOME:-}" ] && [ -d "$TEST_HOME" ]; then
        rm -rf "$TEST_HOME"
    fi
}

# Export for use in tests
export -f cleanup_test_env
export REPO_ROOT
export SUPERPOWERS_DIR
export SUPERPOWERS_SKILLS_DIR
export SUPERPOWERS_PLUGIN_FILE
