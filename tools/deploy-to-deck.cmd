@echo off
rem Runs tools/deploy-to-deck.sh through Git Bash so it works from cmd or PowerShell.
rem Usage: tools\deploy-to-deck.cmd [host] [--no-build] [--sudo] [--dry-run]
setlocal
set "GIT_BASH=%ProgramFiles%\Git\bin\bash.exe"
if not exist "%GIT_BASH%" (
    echo Git Bash was not found at "%GIT_BASH%". Install Git for Windows or run tools/deploy-to-deck.sh from Git Bash.
    exit /b 1
)
pushd "%~dp0.."
"%GIT_BASH%" tools/deploy-to-deck.sh %*
set "STATUS=%ERRORLEVEL%"
popd
exit /b %STATUS%
