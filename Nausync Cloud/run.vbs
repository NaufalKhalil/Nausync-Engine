Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "D:\Project\Coding\Nausync Engine\Nausync Cloud"
objShell.Run "cmd /c node src\index.js >> bot-log.txt 2>&1", 0, False