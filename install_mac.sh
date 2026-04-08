#!/bin/bash
# Inkstain Desktop Agent — Mac Setup
# Run this once to install and build the app

echo ""
echo "  ✦ Inkstain Desktop Agent"
echo "  Setting up..."
echo ""

# Check Python 3
if ! command -v python3 &> /dev/null; then
    echo "  Python 3 is required. Install from python.org"
    exit 1
fi

# Install dependencies
echo "  Installing dependencies..."
pip3 install PyQt6 pyinstaller --quiet

# Build the Mac app
echo "  Building Inkstain.app..."
cd "$(dirname "$0")"

pyinstaller \
  --name "Inkstain Trail" \
  --windowed \
  --onefile \
  --hidden-import PyQt6.QtWidgets \
  --hidden-import PyQt6.QtGui \
  --hidden-import PyQt6.QtCore \
  inkstain_agent/main.py

echo ""
echo "  ✦ Done. Find 'Inkstain Trail.app' in the dist/ folder."
echo "  Drag it to your Applications folder."
echo "  Double-click to start. It lives in your menubar."
echo ""
echo "  The written word will prevail."
echo ""
