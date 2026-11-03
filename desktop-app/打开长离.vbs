Option Explicit
Dim fs, shell, appRoot, nodePath, startPath, extra, item
Set fs = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
appRoot = fs.GetParentFolderName(WScript.ScriptFullName)
nodePath = fs.BuildPath(appRoot, "runtime\node.exe")
startPath = fs.BuildPath(appRoot, "scripts\start.cjs")
If Not fs.FileExists(nodePath) Then
  MsgBox "Missing runtime/node.exe. Please restore the complete application folder.", 16, "Changli"
  WScript.Quit 1
End If
shell.CurrentDirectory = appRoot
extra = ""
For Each item In WScript.Arguments
  If item = "--ui-check" Or item = "--smoke-test" Or item = "--wallpaper-smoke" Then extra = extra & " " & item
Next
shell.Run Chr(34) & nodePath & Chr(34) & " " & Chr(34) & startPath & Chr(34) & extra, 0, False
