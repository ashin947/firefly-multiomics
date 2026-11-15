@echo off
REM ===========================================================================
REM  DEG Studio - package the project for moving to another computer
REM
REM  Produces TWO archives in ..\_transfer :
REM    1) deg-studio-src.zip  - source code only, a few MB
REM    2) R-4.3.2.zip         - R runtime + ALL R packages, about 1.2 GB
REM
REM  Why the R folder must be carried over:
REM    Every R package we installed (DESeq2 / limma / edgeR / apeglm / ...)
REM    lives inside  D:\R-4.3.2\library  - i.e. INSIDE the R installation,
REM    NOT inside this project and NOT in the AppData library.
REM    Copying only the project folder gives you a machine with no R packages.
REM
REM  Usage:
REM    pack-for-transfer.bat          pack source + R runtime
REM    pack-for-transfer.bat src      pack source only (fast)
REM
REM  This file is intentionally pure ASCII: a .bat containing Chinese text
REM  fails to parse under the default GBK code page and exits instantly.
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "TAR=%SystemRoot%\System32\tar.exe"
if not exist "%TAR%" (
  echo [ERROR] tar.exe not found. Windows 10 1803 or newer is required.
  pause
  exit /b 1
)

for %%I in ("%~dp0.") do set "PROJ=%%~nxI"
for %%I in ("%~dp0..") do set "PARENT=%%~fI"
set "OUT=%PARENT%\_transfer"
if not exist "%OUT%" mkdir "%OUT%"

REM ---- locate the R installation (edit this line if your R is elsewhere) ----
set "RROOT=D:\R-4.3.2"
for %%I in ("%RROOT%") do set "RNAME=%%~nxI"

echo.
echo ============================================================
echo   Project : %PROJ%
echo   Source  : %PARENT%\%PROJ%
echo   Output  : %OUT%
echo ============================================================

REM ---------------------------------------------------------------- 1) source
echo.
echo [1/2] Packing source code ...
if exist "%OUT%\deg-studio-src.zip" del /f /q "%OUT%\deg-studio-src.zip"
"%TAR%" -a -c -f "%OUT%\deg-studio-src.zip" ^
  --exclude=node_modules --exclude=*/node_modules ^
  --exclude=out --exclude=*/out ^
  --exclude=dist --exclude=*/dist ^
  --exclude=.tmp --exclude=*/.tmp ^
  --exclude=.tmp-r --exclude=*/.tmp-r ^
  --exclude=.repro --exclude=*/.repro ^
  --exclude=.smoke-tmp --exclude=*/.smoke-tmp ^
  --exclude=test-results --exclude=*/test-results ^
  --exclude=.git --exclude=*/.git ^
  --exclude=*.log ^
  -C "%PARENT%" "%PROJ%"
if errorlevel 1 goto :fail
echo       OK  -^> %OUT%\deg-studio-src.zip

if /i "%~1"=="src" goto :done

REM ------------------------------------------------------------- 2) R runtime
echo.
echo [2/2] Packing R runtime ...
if not exist "%RROOT%\bin\x64\Rscript.exe" (
  echo.
  echo [SKIP] R not found at %RROOT%
  echo        Edit the RROOT line at the top of this script, then run again.
  goto :done
)
for %%I in ("%RROOT%") do (
  set "RPARENT=%%~dpI"
  set "RNAME=%%~nxI"
)
echo       Source: %RROOT%
echo       This is about 1.2 GB - it can take several minutes. Please wait.
if exist "%OUT%\%RNAME%.zip" del /f /q "%OUT%\%RNAME%.zip"
REM Note: do NOT write -C "%RPARENT%" here. %RPARENT% ends with a backslash
REM (e.g. "D:\"), and cmd parses the trailing \" as an escaped quote, which
REM silently swallows the archive member name and tar reports
REM "no files or directories specified". pushd avoids the whole problem.
pushd "%RPARENT%"
"%TAR%" -a -c -f "%OUT%\%RNAME%.zip" "%RNAME%"
set "TARRC=%ERRORLEVEL%"
popd
if not "%TARRC%"=="0" goto :fail
echo       OK  -^> %OUT%\%RNAME%.zip

:done
echo.
echo ============================================================
echo   Done. Files in %OUT% :
dir /b "%OUT%"
echo ============================================================
echo.
echo   How to restore on the new computer:
echo     1. Extract deg-studio-src.zip to any folder, e.g. D:\ai\
echo     2. Extract %RNAME%.zip to D:\ so you get D:\%RNAME% again
echo        (keep the SAME path - then no config change is needed)
echo     3. If the R path differs, open:
echo        %%APPDATA%%\deg-studio\settings.json
echo        and set  "customRPath": "X:\\your\\R\\folder"
echo     4. cd into the project and run:  npm install
echo     5. Double-click start-deg-studio.bat
echo ============================================================
echo.
pause
exit /b 0

:fail
echo.
echo [ERROR] Packing failed. Check free disk space and try again.
pause
exit /b 1
