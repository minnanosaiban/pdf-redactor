@echo off
setlocal

rem ============================================================
rem  pdf-redactor deploy (Cloudflare Pages)
rem  Double-click after design changes to update the live site.
rem
rem  First-time setup (run once in this folder):
rem    npm install
rem    npx wrangler login
rem    npx wrangler pages project create pdf-redactor
rem    Create GitHub repo: https://github.com/new
rem      -> minnanosaiban/pdf-redactor (public)
rem ============================================================

echo === Deploy pdf-redactor to Cloudflare Pages ===
cd /d "%~dp0"
echo Current: %CD%

echo === Install deps if needed ===
if not exist "node_modules\wrangler\" (
    echo Installing dependencies for the first time...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo === Cloudflare Pages deploy ===
call npm run deploy
if %errorlevel% neq 0 (
    echo [ERROR] Deploy failed.
    pause
    exit /b 1
)

echo === Commit ^& Push to GitHub (main) ===
git add .
git commit -m "Update pdf-redactor" || echo No changes to commit
git push -u origin main
if %errorlevel% neq 0 (
    echo [WARN] Git push failed. The Cloudflare deploy itself succeeded.
    echo        GitHub repo may not exist yet, or auth is not set up.
)

echo === Done ===
pause
