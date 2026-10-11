@echo off
setlocal EnableExtensions

set "REELFORGE_ROOT=%~dp0"
if /I "%~1"=="--self-test" (
  echo self-test ok: %REELFORGE_ROOT%
  exit /b 0
)

pushd "%REELFORGE_ROOT%" >nul 2>&1
if errorlevel 1 (
  echo ReelForge Studio could not enter its installation directory: %REELFORGE_ROOT%
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "REELFORGE_NODE_MAJOR=%%V"
if not defined REELFORGE_NODE_MAJOR (
  echo Node.js 24 or newer is required and was not found on PATH.
  goto :failure
)
if %REELFORGE_NODE_MAJOR% LSS 24 (
  echo Node.js 24 or newer is required. Found major version %REELFORGE_NODE_MAJOR%.
  goto :failure
)

if not exist "%REELFORGE_ROOT%node_modules\ffmpeg-static\package.json" goto :install_dependencies
if not exist "%REELFORGE_ROOT%node_modules\ffprobe-static\package.json" goto :install_dependencies
if not exist "%REELFORGE_ROOT%node_modules\tsx\package.json" goto :install_dependencies
if not exist "%REELFORGE_ROOT%node_modules\vite\package.json" goto :install_dependencies
goto :setup_runtime

:install_dependencies
echo Installing dependencies from package-lock.json...
call npm.cmd ci
if errorlevel 1 goto :failure

:setup_runtime
call npm.cmd run setup
if errorlevel 1 goto :failure

if not exist "%REELFORGE_ROOT%apps\web\dist\index.html" goto :build_application
if not exist "%REELFORGE_ROOT%apps\server\dist\index.js" goto :build_application
if not exist "%REELFORGE_ROOT%apps\worker\dist\index.js" goto :build_application
goto :launch_application

:build_application
echo Building ReelForge Studio...
call npm.cmd run build
if errorlevel 1 goto :failure

:launch_application
node "%REELFORGE_ROOT%scripts\launcher.mjs" %*
set "REELFORGE_EXIT=%ERRORLEVEL%"
goto :finish

:failure
set "REELFORGE_EXIT=1"

:finish
popd

if not "%REELFORGE_EXIT%"=="0" (
  echo.
  echo ReelForge Studio failed to start. The terminal is being kept open so the error remains visible.
  pause
)
exit /b %REELFORGE_EXIT%
