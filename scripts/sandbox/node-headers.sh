#!/usr/bin/env bash

# Shared Node-header selection for both sandbox stages. Keep these functions
# free of filesystem side effects so the mount contract can be tested directly.

sandbox_select_node_dir() {
  local configured_node_dir="$1"
  local install_shortcut="$2"
  local sandbox_home="$3"
  local discovered_node_dir="${4:-}"

  if [ -n "$configured_node_dir" ]; then
    printf '%s\n' "$configured_node_dir"
  elif [ "$install_shortcut" = true ]; then
    # The installer may replace the startup runtime before npm builds native
    # addons. This managed prefix contains matching headers by the time npm runs.
    printf '%s/.hermes/node\n' "$sandbox_home"
  elif [ -n "$discovered_node_dir" ]; then
    printf '%s\n' "$discovered_node_dir"
  fi
}

sandbox_visible_node_headers() {
  local sandbox_home="$1"
  local node_dir="$2"
  local use_host_runtime="$3"

  case "$node_dir" in
    "$sandbox_home"/*)
      # Sandbox HOME is a writable bind mount shared by both stages.
      printf '%s\n' "$node_dir"
      ;;
    /nix/*)
      # Nix store prefixes remain visible only on the Nix runtime path.
      if [ "$use_host_runtime" = false ]; then
        printf '%s\n' "$node_dir"
      fi
      ;;
  esac
}
