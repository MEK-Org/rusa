#!/bin/bash

# Find the wrapper's real path to prevent self-recursion
SELF_PATH=$(realpath "$0" 2>/dev/null || readlink -f "$0")

REAL_GH=""
# Parse PATH to find the first executable named 'gh' that is NOT the wrapper itself
IFS=':' read -r -a path_array <<< "$PATH"
for dir in "${path_array[@]}"; do
  [ -z "$dir" ] && continue
  if [ -x "$dir/gh" ]; then
    candidate_path=$(realpath "$dir/gh" 2>/dev/null || readlink -f "$dir/gh")
    if [ "$candidate_path" != "$SELF_PATH" ]; then
      REAL_GH="$candidate_path"
      break
    fi
  fi
done

# If we couldn't find another 'gh' on PATH, fall back to /usr/bin/gh
if [ -z "$REAL_GH" ]; then
  REAL_GH="/usr/bin/gh"
fi

# If REAL_GH is still the wrapper itself, prevent recursion
if [ "$REAL_GH" = "$SELF_PATH" ]; then
  echo "error: gh wrapper self-recursion detected. Ensure the real gh is installed and accessible." >&2
  exit 127
fi

# Create a temporary file to capture stderr of the real gh
STDERR_TMP=$(mktemp 2>/dev/null)
if [ -z "$STDERR_TMP" ]; then
  # Fallback: run the real gh directly without capturing stderr if temp directory is not writable
  exec "$REAL_GH" "$@"
fi

# Clean up temp file on exit
trap 'rm -f "$STDERR_TMP"' EXIT

# Execute the real gh:
# stdout (fd 1) goes directly through
# stderr (fd 2) is captured in STDERR_TMP
"$REAL_GH" "$@" 2>"$STDERR_TMP"
EXIT_CODE=$?

# Write the real gh stderr back to stderr
cat "$STDERR_TMP" >&2

# On non-zero exit, append the pre-canned hint to stderr
if [ $EXIT_CODE -ne 0 ]; then
  echo 'hint: GitHub writes go through the tracker MCP (it stamps identity and works around the read-only worker PAT). Raw '\''gh'\'' writes fail with "Resource not accessible by personal access token"; reads on raw gh are fine.' >&2
fi

exit $EXIT_CODE
