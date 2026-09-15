' backend-tray.vbs
' Double-clique sur ce fichier (ou mets-en un raccourci sur le bureau /
' dans le dossier Demarrage de Windows) pour lancer l'icone de zone de
' notification, sans fenetre PowerShell visible.

Dim fso, scriptDir, shell
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\backend-tray.ps1""", 0, False
