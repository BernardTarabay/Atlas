@echo off
REM Starts the Atlas document platform: the API (which also serves the UI)
REM and the background worker.
REM
REM PostgreSQL is already installed as a Windows service set to Automatic, so
REM it comes up on its own before this runs -- this script only owns the two
REM Node processes.
REM
REM There is no Redis/Memurai any more: migration 040 moved the job queue into
REM the processing_jobs table, which is why Postgres is now the only service
REM this depends on.
REM
REM Launched at logon by scripts\install-autostart.ps1. Run it by hand to
REM start everything without rebooting.
REM
REM   start-atlas.bat                  start, refusing if anything is already up
REM   set SKIP_PREFLIGHT=1 ^& start-atlas.bat   start anyway (two of everything)

cd /d "%~dp0.."

REM This is the PRODUCTION entry point, so say so. Without it Node and Express
REM ran in development mode in the deployment the client actually uses --
REM slower routing, verbose error rendering, and, more to the point,
REM config/env.js only enforces its minimum secret length when NODE_ENV is
REM production. The one place that check matters most was the one place it
REM was switched off.
set NODE_ENV=production

REM Logs live beside the app rather than in %TEMP%, which Windows Disk Cleanup
REM empties -- losing exactly the history you want when asking "why did it
REM stop overnight?".
set LOGDIR=%~dp0..\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

REM ---------------------------------------------------------------------
REM REFUSE TO START A SECOND COPY.
REM
REM restart-atlas.bat has always guarded the reverse direction (it refuses to
REM start production while a dev server is up). This is the missing half, and
REM the half that runs unattended: this script is the scheduled task's action,
REM so it is the one nobody is watching when it goes wrong.
REM
REM Starting a second copy is not merely redundant, it actively breaks things:
REM   - two API processes race for port 5000. The winner is arbitrary, and the
REM     LOSER stays alive but unbound -- healthy in the process list, serving
REM     nothing.
REM   - two WORKERS both consume the job queue, so every job competes with a
REM     second claimant and the Gemini request rate doubles. The queue itself
REM     stays correct (SKIP LOCKED means no job runs twice), but the spend and
REM     the load do not.
REM
REM Detection is by PROCESS, not by probing port 5000, for two reasons. A port
REM probe cannot see the unbound loser above -- the exact case most worth
REM catching. And restart-atlas.bat kills Atlas and then calls THIS script a
REM couple of seconds later; a port that is still in TIME_WAIT would make that
REM restart fail intermittently, turning a guard into a flake.
REM
REM The checks are ordered dev-first because the two refusals want different
REM advice, and "a dev server is running" is the more specific diagnosis.
REM ---------------------------------------------------------------------
if "%SKIP_PREFLIGHT%"=="1" goto startatlas

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dev = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*nodemon*' }; if ($dev) { exit 1 } else { exit 0 }"
if errorlevel 1 goto devrunning

REM Forward AND backslash variants: this script launches "src\server.js" and
REM the npm scripts launch "src/server.js". Matching one spelling only would
REM let the other slip through -- the same trap restart-atlas.bat documents.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$up = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -match 'src[\\/]server\.js' -or $_.CommandLine -match 'workers[\\/]runner\.js') }; if ($up) { exit 1 } else { exit 0 }"
if errorlevel 1 goto alreadyrunning

goto startatlas

REM goto rather than a parenthesised if-block. Multi-line blocks in cmd are
REM parsed as one command, so an escaped parenthesis inside an echo can end the
REM block early -- which is what swallowed restart-atlas.bat's exit code once
REM already, making its refusal invisible to anything checking it.

:devrunning
echo.
echo   A development server is already running -- npm run dev / nodemon.
echo.
echo   Not starting Atlas in production mode on top of it. Two APIs would
echo   race for port 5000, and two workers would double the Gemini request
echo   rate and the load on this machine.
echo.
echo   To stop the dev server and run production instead:
echo     restart-atlas.bat force
echo.
call :logrefusal "refused: a dev server (nodemon) is already running"
exit /b 1

:alreadyrunning
echo.
echo   Atlas is already running.
echo.
echo   Open http://localhost:5000 -- it is already there. To apply code
echo   changes, use restart-atlas.bat, which stops the running processes
echo   first.
echo.
call :logrefusal "refused: Atlas is already running"
exit /b 1

REM A refusal at logon has no console to print to. Recording it means the
REM answer to "why is Atlas not up?" is one file away instead of invisible --
REM which is the entire failure mode this guard exists to prevent, so leaving
REM the guard itself silent would just move the problem.
:logrefusal
echo [%DATE% %TIME%] %~1 >> "%LOGDIR%\atlas-start.log"
goto :eof

:startatlas

REM Rotated on each start so they cannot grow without bound: the previous run
REM is kept as .1 and anything older is overwritten.
REM
REM Deliberately AFTER the guard. Rotating first meant a refused start rotated
REM away the logs of the instance that was still running perfectly well --
REM destroying the diagnostics of the healthy process to record the failure of
REM one that never began.
if exist "%LOGDIR%\atlas-api.log"    move /y "%LOGDIR%\atlas-api.log"    "%LOGDIR%\atlas-api.1.log"    >nul
if exist "%LOGDIR%\atlas-worker.log" move /y "%LOGDIR%\atlas-worker.log" "%LOGDIR%\atlas-worker.1.log" >nul

REM Both are started detached and windowless -- the person using this should
REM never see a console, and closing one must not take the app down.
start "" /b /min cmd /c "cd backend && node src\server.js >> "%LOGDIR%\atlas-api.log" 2>&1"
start "" /b /min cmd /c "cd backend && node src\workers\runner.js >> "%LOGDIR%\atlas-worker.log" 2>&1"

echo Atlas starting. Open http://localhost:5000
echo Logs: %LOGDIR%\atlas-api.log and %LOGDIR%\atlas-worker.log
