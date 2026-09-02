Option Explicit

If WScript.Arguments.Count <> 1 Then
  WScript.Quit 2
End If

Dim shell, scriptPath, command
scriptPath = WScript.Arguments(0)
command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & _
  scriptPath & """"

Set shell = CreateObject("WScript.Shell")
WScript.Quit shell.Run(command, 0, True)
