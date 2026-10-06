@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm >nul 2>nul
if errorlevel 1 goto missing_npm

if not exist "node_modules\vite\bin\vite.js" (
    echo Dependencies are missing. Installing with npm...
    call npm install
    if errorlevel 1 goto install_failed
)

call npm run dev -- --open %*
if errorlevel 1 goto run_failed
exit /b 0

:missing_node
echo Node.js is required but was not found on PATH.
echo Install Node.js, then run this file again.
goto failed

:missing_npm
echo npm is required but was not found on PATH.
echo Repair or reinstall Node.js, then run this file again.
goto failed

:install_failed
echo Dependency installation failed. Check the npm output above.
goto failed

:run_failed
echo The development server exited with an error.
goto failed

:failed
pause
exit /b 1
