' backend-tray.vbs
' Double-click this file (or place a shortcut on the desktop /
' in the Windows Startup folder) to launch the notification area icon,
' without any visible PowerShell window.

Dim fso, scriptDir, shell
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\backend-tray.ps1""", 0, False
