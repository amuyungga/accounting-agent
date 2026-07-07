@echo off
cd /d "%~dp0"
echo Removing git lock files...
del /f /q ".git\index.lock" 2>nul
del /f /q ".git\HEAD.lock" 2>nul
echo Committing and pushing...
git add -A
git status
git commit -m "feat: sync-now pulls directly from GitHub — no local watcher needed" 2>nul || echo (nothing new to commit)
git push origin main --force
echo.
echo Done! Railway will redeploy in ~60 seconds.
pause
