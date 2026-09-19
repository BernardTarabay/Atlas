' Runs a command with NO VISIBLE WINDOW, and hands its exit code back.
'
' WHY THIS FILE EXISTS
'
' The Atlas watchdog runs scripts\start-atlas.bat every few minutes. A
' scheduled task whose action is cmd.exe pops a console window each time it
' fires -- briefly, but visibly, and on a machine somebody is actually using
' that is a black rectangle stealing focus several times an hour, forever.
'
' TWO THINGS THAT LOOK LIKE THEY FIX IT AND DO NOT:
'
'   New-ScheduledTaskSettingsSet -Hidden
'       Hides the TASK from Task Scheduler's library list. It has nothing to
'       do with windows. This was in the installer, next to a comment claiming
'       it kept the console from flashing, and the console flashed anyway.
'
'   New-ScheduledTaskAction -WindowStyle Hidden
'       Does not exist. The cmdlet has no such parameter, so writing it either
'       errors or -- as happened here -- was only ever mentioned in a comment
'       and never actually passed.
'
' `powershell -WindowStyle Hidden` is closer but still paints a window for a
' frame or two on some builds before the style applies, which is exactly the
' flash being removed.
'
' WScript with a window style of 0 never creates a window at all. It is the
' one approach where "hidden" is a property of how the process is launched
' rather than something applied to a window that already exists.
'
' THE EXIT CODE IS PRESERVED, and that is not incidental. start-atlas.bat's
' exit codes describe the state of Atlas (0 = up, 1 = down and unfixable,
' 2 = a dev server owns the port), and Task Scheduler's "Last Run Result"
' column is where an operator reads them. Running with bWaitOnReturn = True
' and quitting with the result is what keeps that column meaningful instead of
' always reporting wscript's own success.
'
'   wscript.exe //nologo run-hidden.vbs <command> [args...]
'
' TESTING IT BY HAND, AND THE THING THAT WILL FOOL YOU
'
' wscript.exe is a GUI-subsystem binary, so an interactive shell does NOT wait
' on it -- run this from PowerShell and $LASTEXITCODE comes back empty, which
' looks exactly like the exit code being lost. It is not; the shell simply
' returned before the process did. Task Scheduler waits, and sees the real
' code. To reproduce what Task Scheduler sees:
'
'   $p = Start-Process wscript.exe -ArgumentList "//nologo","run-hidden.vbs","<cmd>" -Wait -PassThru
'   $p.ExitCode
'
' Verified against a batch file exiting 7 (returned 7) and one exiting 0
' (returned 0), with no window appearing in either case.

Option Explicit

Dim shell, commandLine, i

If WScript.Arguments.Count = 0 Then
    WScript.Quit 1
End If

Set shell = CreateObject("WScript.Shell")

' Every argument quoted individually, so a path containing spaces survives.
commandLine = """" & WScript.Arguments(0) & """"
For i = 1 To WScript.Arguments.Count - 1
    commandLine = commandLine & " """ & WScript.Arguments(i) & """"
Next

' 0    = hidden window
' True = wait for it to finish, and return its exit code
WScript.Quit shell.Run(commandLine, 0, True)
