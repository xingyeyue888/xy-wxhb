@echo off
rem ==========================================================
rem  xy-wxhb launcher  (Windows)
rem
rem  Keep this file pure ASCII.
rem  cmd parses a .bat in the ANSI codepage, so UTF-8 Chinese
rem  in here gets split into garbage and can break commands.
rem  All Chinese hints are printed by serve.py instead.
rem
rem  Python is auto-detected in this order:
rem    1. XY_WXHB_PYTHON environment variable
rem    2. python\python.exe next to this file (portable bundle)
rem    3. the python that ships with your ComfyUI (via comfy-root.txt)
rem    4. the py launcher (py -3)
rem    5. python / python3 on PATH
rem    6. a ComfyUI*/python folder on any local disk
rem  Nothing found? Set XY_WXHB_PYTHON or see the message at the end.
rem ==========================================================
setlocal EnableExtensions
title xy-wxhb
cd /d "%~dp0"

set "PYEXE="
set "PYARG="

call :use_env
if defined PYEXE goto check
call :use_bundled
if defined PYEXE goto check
call :use_comfy_root
if defined PYEXE goto check
call :use_launcher
if defined PYEXE goto check
call :use_path
if defined PYEXE goto check
call :use_disk_scan
if defined PYEXE goto check

call :fail_no_python
goto :eof


:check
if not exist "%~dp0serve.py" (
  echo.
  echo   [ERROR] serve.py is missing next to start.bat
  echo.
  pause
  exit /b 1
)

rem ---- serve.py needs Python 3.8+ ----
"%PYEXE%" %PYARG% -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Python 3.8 or newer is required.
  echo           Detected: %PYEXE% %PYARG%
  "%PYEXE%" %PYARG% -V
  echo.
  echo   Install a newer Python, or set XY_WXHB_PYTHON to a 3.8+ python.exe
  echo.
  pause
  exit /b 1
)

echo   Python  %PYEXE% %PYARG%
echo.
"%PYEXE%" %PYARG% -u "%~dp0serve.py" %*
if errorlevel 1 pause
exit /b 0


rem ----------------------------------------------------------
rem  probes
rem ----------------------------------------------------------
:use_env
if defined PYEXE goto :eof
if not defined XY_WXHB_PYTHON goto :eof
if not exist "%XY_WXHB_PYTHON%" goto :eof
set "PYEXE=%XY_WXHB_PYTHON%"
goto :eof

:use_bundled
if defined PYEXE goto :eof
if exist "%~dp0python\python.exe" set "PYEXE=%~dp0python\python.exe"
if not defined PYEXE if exist "%~dp0python_embeded\python.exe" set "PYEXE=%~dp0python_embeded\python.exe"
if not defined PYEXE if exist "%~dp0runtime\python.exe" set "PYEXE=%~dp0runtime\python.exe"
goto :eof

:use_comfy_root
if defined PYEXE goto :eof
if not exist "%~dp0comfy-root.txt" goto :eof
set "CROOT="
set /p CROOT=<"%~dp0comfy-root.txt"
if not defined CROOT goto :eof
for %%R in ("%CROOT%") do set "CPARENT=%%~dpR"
if not defined CPARENT goto :eof
if exist "%CPARENT%python\python.exe" set "PYEXE=%CPARENT%python\python.exe"
if not defined PYEXE if exist "%CPARENT%python_embeded\python.exe" set "PYEXE=%CPARENT%python_embeded\python.exe"
goto :eof

:use_launcher
if defined PYEXE goto :eof
where py >nul 2>nul
if errorlevel 1 goto :eof
py -3 -c "import sys" >nul 2>nul
if errorlevel 1 goto :eof
set "PYEXE=py"
set "PYARG=-3"
goto :eof

:use_path
if defined PYEXE goto :eof
where python >nul 2>nul
if errorlevel 1 goto :try_python3
python -c "import sys" >nul 2>nul
if errorlevel 1 goto :try_python3
set "PYEXE=python"
goto :eof

:try_python3
if defined PYEXE goto :eof
where python3 >nul 2>nul
if errorlevel 1 goto :eof
python3 -c "import sys" >nul 2>nul
if errorlevel 1 goto :eof
set "PYEXE=python3"
goto :eof

:use_disk_scan
if defined PYEXE goto :eof
for %%D in (C D E F G H) do (
  if not defined PYEXE if exist "%%D:\" (
    for /d %%K in ("%%D:\ComfyUI*") do (
      if not defined PYEXE if exist "%%~fK\python_embeded\python.exe" set "PYEXE=%%~fK\python_embeded\python.exe"
      if not defined PYEXE if exist "%%~fK\python\python.exe" set "PYEXE=%%~fK\python\python.exe"
    )
  )
)
goto :eof

:fail_no_python
echo.
echo   ==========================================================
echo    Python not found.
echo   ==========================================================
echo.
echo    xy-wxhb needs Python 3.8+ to serve its files locally.
echo    Pick one of these:
echo.
echo      1) Install Python from https://www.python.org/downloads/
echo         (tick "Add python.exe to PATH" during setup)
echo.
echo      2) If you already run ComfyUI, point straight at its python:
echo             set XY_WXHB_PYTHON=E:\ComfyUI_windows_portable\python_embeded\python.exe
echo             start.bat
echo.
echo      3) Copy a portable python into this folder as:
echo             python\python.exe
echo.
echo    Tip: you can also start it manually:
echo             ^<your python^> serve.py
echo.
pause
exit /b 1
