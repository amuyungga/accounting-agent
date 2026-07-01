@echo off
cd /d "C:\Users\sntmi\Claude\Projects\Ai Marketing and Sales agent"
echo.
echo ============================================================
echo  Setting up Agent Command Watcher as a background service
echo ============================================================
echo.

echo [1/4] Installing PM2 (process manager)...
call npm install -g pm2
if %errorlevel% neq 0 (
  echo ERROR: npm install failed. Make sure Node.js is installed.
  pause & exit /b 1
)

echo.
echo [2/4] Installing PM2 Windows startup support...
call npm install -g pm2-windows-startup
if %errorlevel% neq 0 (
  echo WARNING: pm2-windows-startup failed — watcher won't auto-start on reboot.
  echo You can still use it manually.
)

echo.
echo [3/4] Starting command-watcher.js with PM2...
call pm2 delete agent-watcher 2>nul
call pm2 start command-watcher.js --name "agent-watcher" --cwd "%~dp0"
if %errorlevel% neq 0 (
  echo ERROR: PM2 failed to start the watcher.
  pause & exit /b 1
)

echo.
echo [4/4] Saving PM2 config + enabling auto-start on reboot...
call pm2 save
call pm2-startup install 2>nul

echo.
echo ============================================================
echo  Done! Command watcher is now running in the background.
echo.
echo  Useful commands:
echo    pm2 status           - see if watcher is running
echo    pm2 logs agent-watcher - view live watcher output
echo    pm2 restart agent-watcher - restart it
echo    pm2 stop agent-watcher    - stop it
echo    pm2 delete agent-watcher  - remove it entirely
echo ============================================================
echo.
pause
