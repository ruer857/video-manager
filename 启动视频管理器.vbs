Option Explicit

Dim shell, fileSystem, appRoot, launcher, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

appRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
launcher = fileSystem.BuildPath(appRoot, "start-video-manager.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & launcher & """"

shell.Run command, 0, False
