@echo off
rem ============================================================
rem  WangBlog API - Windows one-click startup
rem  Double-click to run: env check -> deps check -> start server
rem ============================================================
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set PORT=%WB_PORT%
if "%PORT%"=="" set PORT=8310
set LOG_PREFIX=[WangBlog]

echo ============================================================
echo   WangBlog API startup script
echo   Workdir : %CD%
echo   Port    : %PORT%
echo ============================================================
echo.

rem ---- [1/4] Python environment check ----
echo %LOG_PREFIX% [1/4] Checking Python environment...
where python >nul 2>nul
if errorlevel 1 (
    echo %LOG_PREFIX% [ERROR] Python not found in PATH.
    echo %LOG_PREFIX% Please install Python 3.10+ from https://www.python.org/downloads/
    echo %LOG_PREFIX% and check "Add Python to PATH" during installation.
    goto :fail
)
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo %LOG_PREFIX% Found Python %PYVER%
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 (
    echo %LOG_PREFIX% [ERROR] Python 3.10+ is required, current: %PYVER%
    goto :fail
)

rem ---- [2/4] Virtual environment ----
echo %LOG_PREFIX% [2/4] Preparing virtual environment...
if not exist ".venv\Scripts\python.exe" (
    echo %LOG_PREFIX% Creating .venv ...
    python -m venv .venv
    if errorlevel 1 (
        echo %LOG_PREFIX% [ERROR] Failed to create virtual environment.
        goto :fail
    )
)
set VENV_PY=.venv\Scripts\python.exe

rem ---- [3/4] Dependencies check ----
echo %LOG_PREFIX% [3/4] Checking dependencies...
%VENV_PY% -c "import fastapi, uvicorn, jwt, multipart, pyotp" >nul 2>nul
if errorlevel 1 (
    echo %LOG_PREFIX% Dependencies missing, installing from requirements.txt ...
    %VENV_PY% -m pip install --upgrade pip
    %VENV_PY% -m pip install -r requirements.txt
    if errorlevel 1 (
        echo %LOG_PREFIX% [ERROR] pip install failed. Check network or mirror:
        echo %LOG_PREFIX%   %VENV_PY% -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
        goto :fail
    )
    echo %LOG_PREFIX% Dependencies installed.
) else (
    echo %LOG_PREFIX% Dependencies OK, skip install.
)

rem ---- [4/4] Port check and start ----
echo %LOG_PREFIX% [4/4] Checking port %PORT% ...
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo %LOG_PREFIX% [WARN] Port %PORT% is already in use.
    echo %LOG_PREFIX% Either stop the existing process, or run with another port:
    echo %LOG_PREFIX%   set WB_PORT=8311 ^& start.bat
    goto :fail
)

echo.
echo %LOG_PREFIX% Starting WangBlog API ...
echo %LOG_PREFIX%   URL  : http://127.0.0.1:%PORT%
echo %LOG_PREFIX%   Docs : http://127.0.0.1:%PORT%/docs
echo %LOG_PREFIX%   Admin demo account: admin / admin123 ^(TOTP: any 6 digits^)
echo %LOG_PREFIX% Press Ctrl+C to stop.
echo.
%VENV_PY% -m uvicorn app.main:app --host 0.0.0.0 --port %PORT%
if errorlevel 1 (
    echo.
    echo %LOG_PREFIX% [ERROR] Server exited abnormally. Check the log above.
    goto :fail
)
goto :end

:fail
echo.
echo %LOG_PREFIX% Startup FAILED.
pause
exit /b 1

:end
endlocal
