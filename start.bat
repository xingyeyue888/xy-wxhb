@echo off
rem ==========================================================
rem  wy-canvas launcher  (keep this file pure ASCII!)
rem  cmd reads .bat in the ANSI codepage; UTF-8 Chinese here
rem  would be split into garbage and break the commands.
rem ==========================================================
setlocal

set "PY=E:\ComfyUI-aki-v3.2\python\python.exe"

if not exist "%PY%" (
  echo.
  echo   [ERROR] Python not found:
  echo           %PY%
  echo   Open start.bat with Notepad and point PY to your python.exe
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0serve.py" (
  echo.
  echo   [ERROR] serve.py is missing next to start.bat
  echo.
  pause
  exit /b 1
)

"%PY%" "%~dp0serve.py"
if errorlevel 1 pause
endlocal
