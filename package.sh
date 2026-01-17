#!/usr/bin/env bash

# Script to build and package code-server
# Usage: ./package.sh [version]
# Example: ./package.sh 4.9.1 or ./package.sh 1.95.3.25227

VERSION="${1:-0.0.0}"

# Validate version format (X.Y.Z or X.Y.Z.W)
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  echo "Error: Invalid version format. Expected: X.Y.Z or X.Y.Z.W (e.g., 4.9.1 or 1.95.3.25227)"
  echo "Usage: ./package.sh [version]"
  return 1 2>/dev/null || exit 1
fi

echo "==> Building code-server version $VERSION"
echo ""

echo "==> Installing dependencies..."
if ! npm install; then
  echo "Error: Failed to install dependencies"
  return 1 2>/dev/null || exit 1
fi

echo "==> Building code-server..."
if ! npm run build; then
  echo "Error: Failed to build code-server"
  return 1 2>/dev/null || exit 1
fi

echo "==> Building VS Code..."
if ! VERSION="$VERSION" npm run build:vscode; then
  echo "Error: Failed to build VS Code"
  return 1 2>/dev/null || exit 1
fi

echo "==> Creating release (keeping node_modules)..."
if ! KEEP_MODULES=1 npm run release; then
  echo "Error: Failed to create release"
  return 1 2>/dev/null || exit 1
fi

echo "==> Building standalone release..."
if ! npm run release:standalone; then
  echo "Error: Failed to build standalone release"
  return 1 2>/dev/null || exit 1
fi

echo "==> Running integration tests..."
if ! npm run test:integration; then
  echo "Error: Failed to run integration tests"
  return 1 2>/dev/null || exit 1
fi

echo "==> Creating package..."
if ! npm run package; then
  echo "Error: Failed to create package"
  return 1 2>/dev/null || exit 1
fi

echo ""
echo "==> Build complete!"
echo "    Version: $VERSION"
echo "    Package location: release/release-packages/"


