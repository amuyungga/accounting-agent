@echo off
cd /d "C:\Users\sntmi\Claude\Projects\Ai Marketing and Sales agent"
echo Removing stale git locks...
if exist .git\index.lock del /f .git\index.lock
if exist .git\HEAD.lock del /f .git\HEAD.lock
echo Merging remote changes...
git pull --no-rebase -X ours
echo Pushing domain fix to GitHub...
git push
echo Done! Railway will redeploy with the correct from address.
pause
