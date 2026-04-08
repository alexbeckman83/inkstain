@echo off
echo.
echo   Inkstain Desktop Agent — Windows Setup
echo   Setting up...
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo   Python 3 is required. Install from python.org
    pause
    exit /b 1
)

echo   Installing dependencies...
pip install PyQt6 pyinstaller --quiet

echo   Building Inkstain Trail.exe...
cd /d "%~dp0"

pyinstaller ^
  --name "Inkstain Trail" ^
  --windowed ^
  --onefile ^
  --hidden-import PyQt6.QtWidgets ^
  --hidden-import PyQt6.QtGui ^
  --hidden-import PyQt6.QtCore ^
  inkstain_agent\main.py

echo.
echo   Done. Find "Inkstain Trail.exe" in the dist\ folder.
echo   Double-click to start. It lives in your system tray.
echo.
echo   The written word will prevail.
echo.
pause
