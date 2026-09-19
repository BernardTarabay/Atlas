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
REM Launched at logon by scripts\install-autostart.ps1, and again every few
REM minutes by the same task as a watchdog. Run it by hand to start everything
REM without rebooting.
REM
REM   start-atlas.bat                  start whatever is missing, refusing duplicates
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
REM REFUSE TO START A SECOND COPY -- BUT ONLY OF WHAT IS ACTUALLY RUNNING.
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
REM WHAT CHANGED, AND WHY IT IS NOT INLINE ANY MORE
REM
REM This guard used to be two PowerShell one-liners here in the .bat, and it
REM held Atlas DOWN for two days (2026-08-29 to 08-31). Five abandoned
REM `node --watch src/server.js` watchers were left behind by a dev session.
REM The dev check only knew the word 'nodemon', so it did not recognise them;
REM the "is Atlas running?" check then matched server.js in their command
REM lines and declared Atlas healthy. The watchdog logged
REM "refused: Atlas is already running" 1,049 times while the worker was dead
REM and nothing was consuming the job queue.
REM
REM The decision now lives in preflight-atlas.ps1, which has a test suite
REM (test-preflight-atlas.ps1) covering that exact state, because a guard this
REM load-bearing should not be verifiable only by breaking production.
REM
REM Two rules came out of it and are worth keeping in mind here:
REM   - a watcher with no child process is a HUSK, not a running server.
REM     `node --watch` outlives its child on purpose.
REM   - the API and the worker are asked about SEPARATELY. OR-ing them meant a
REM     surviving API masked a dead worker forever, which is the half-down
REM     state that hurts most: the UI answers, and nothing gets processed.
REM ---------------------------------------------------------------------

if "%SKIP_PREFLIGHT%"=="1" goto startboth

set PREFLIGHT=%~dp0preflight-atlas.ps1
if not exist "%PREFLIGHT%" goto nopreflight

powershell -NoProfile -ExecutionPolicy Bypass -File "%PREFLIGHT%"

REM Descending order, because cmd's `if errorlevel N` means "N or greater".
REM Written the other way round, `if errorlevel 1` would swallow every case.
if errorlevel 4 goto alreadyrunning
if errorlevel 3 goto startworkeronly
if errorlevel 2 goto startapionly
if errorlevel 1 goto devrunning
goto startboth

REM goto rather than a parenthesised if-block. Multi-line blocks in cmd are
REM parsed as one command, so an escaped parenthesis inside an echo can end the
REM block early -- which is what swallowed restart-atlas.bat's exit code once
REM already, making its refusal invisible to anything checking it.

:nopreflight
echo.
echo   Cannot find preflight-atlas.ps1 next to this script.
echo.
echo   Refusing to start rather than starting blind: without the guard this
echo   script would add a second API and a second worker every few minutes,
echo   which is far worse than the outage that would cause.
echo.
call :logline "refused: preflight-atlas.ps1 is missing"
exit /b 1

:devrunning
echo.
echo   A development server is already running -- nodemon or node --watch.
echo.
echo   Not starting Atlas in production mode on top of it. Two APIs would
echo   race for port 5000, and two workers would double the Gemini request
echo   rate and the load on this machine.
echo.
echo   To stop the dev server and run production instead:
echo     restart-atlas.bat force
echo.
call :logline "refused: a live dev server is already running"
exit /b 2

:alreadyrunning
echo.
echo   Atlas is already running -- API and worker both up.
echo.
echo   Open http://localhost:5000 -- it is already there. To apply code
echo   changes, use restart-atlas.bat, which stops the running processes
echo   first.
echo.
call :logline "refused: Atlas is already running"
REM EXIT 0, NOT 1, AND THE DIFFERENCE IS THE WHOLE POINT OF THIS BLOCK.
REM
REM This is the branch the watchdog takes almost every time it fires: Atlas is
REM up, so there is nothing to do. It used to exit 1, and Task Scheduler
REM faithfully recorded "Last Run Result: 0x1" forever -- on a healthy machine.
REM
REM That is worse than no signal. The first thing anybody opens Task Scheduler
REM to look at is that column, and it read as a failure in exactly the state we
REM want, which taught whoever looked to ignore it. A genuine failure then had
REM nowhere to show up.
REM
REM So the codes now describe the STATE OF ATLAS, not the outcome of this
REM script's attempt to change it:
REM
REM   0  Atlas is up -- started just now, or already was
REM   1  Atlas is NOT up and this script could not fix it (guard missing)
REM   2  Atlas is NOT up on purpose: a dev server owns the port
REM
REM "Last Run Result: The operation completed successfully" now means Atlas is
REM running, which is the question the column is being asked.
exit /b 0

REM A refusal at logon has no console to print to. Recording it means the
REM answer to "why is Atlas not up?" is one file away instead of invisible --
REM which is the entire failure mode this guard exists to prevent, so leaving
REM the guard itself silent would just move the problem.
REM
REM Successful starts are recorded too, and were not before. A log containing
REM nothing but refusals cannot answer "when did it last actually start?",
REM which was the first question asked during the outage above and the one
REM the file could not answer.
:logline
echo [%DATE% %TIME%] %~1 >> "%LOGDIR%\atlas-start.log"
goto :eof

REM Log rotation happens per-process, and only for the process being started.
REM Rotating both when starting one would throw away the live log of the half
REM that is running perfectly well.
REM
REM Deliberately AFTER the guard, too. Rotating first meant a refused start
REM rotated away the logs of the instance that was still running -- destroying
REM the diagnostics of the healthy process to record the failure of one that
REM never began.

:startboth
if exist "%LOGDIR%\atlas-api.log"    move /y "%LOGDIR%\atlas-api.log"    "%LOGDIR%\atlas-api.1.log"    >nul
if exist "%LOGDIR%\atlas-worker.log" move /y "%LOGDIR%\atlas-worker.log" "%LOGDIR%\atlas-worker.1.log" >nul
REM Both are started detached and windowless -- the person using this should
REM never see a console, and closing one must not take the app down.
start "" /b /min cmd /c "cd backend && node src\server.js >> "%LOGDIR%\atlas-api.log" 2>&1"
start "" /b /min cmd /c "cd backend && node src\workers\runner.js >> "%LOGDIR%\atlas-worker.log" 2>&1"
call :logline "started: API and worker"
echo Atlas starting. Open http://localhost:5000
echo Logs: %LOGDIR%\atlas-api.log and %LOGDIR%\atlas-worker.log
exit /b 0

:startapionly
if exist "%LOGDIR%\atlas-api.log" move /y "%LOGDIR%\atlas-api.log" "%LOGDIR%\atlas-api.1.log" >nul
start "" /b /min cmd /c "cd backend && node src\server.js >> "%LOGDIR%\atlas-api.log" 2>&1"
call :logline "started: API only -- the worker was already running"
echo API starting (the worker was already running). Open http://localhost:5000
echo Log: %LOGDIR%\atlas-api.log
exit /b 0

:startworkeronly
if exist "%LOGDIR%\atlas-worker.log" move /y "%LOGDIR%\atlas-worker.log" "%LOGDIR%\atlas-worker.1.log" >nul
start "" /b /min cmd /c "cd backend && node src\workers\runner.js >> "%LOGDIR%\atlas-worker.log" 2>&1"
call :logline "started: worker only -- the API was already running"
echo Worker starting (the API was already running).
echo Log: %LOGDIR%\atlas-worker.log
exit /b 0
