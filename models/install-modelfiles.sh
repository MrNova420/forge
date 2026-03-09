#!/bin/bash
# Install custom Forge modelfiles into Ollama
MODELS_DIR="$(dirname "$0")"
BASE_MODEL="${1:-phi3.5-forge}"

for mfile in "$MODELS_DIR"/*.modelfile; do
  name=$(basename "$mfile" .modelfile)
  echo "Creating model: $name from $mfile"
  # Update FROM line to use the specified base model
  sed "s/FROM phi3.5-forge/FROM $BASE_MODEL/" "$mfile" > /tmp/forge_mf_tmp.modelfile
  ollama create "$name" -f /tmp/forge_mf_tmp.modelfile && echo "✓ $name" || echo "✗ $name failed"
done
echo "Done. Run 'ollama list' to verify."
