# Masaüstüne "Hafif Stüdyo" kısayolu oluşturur.
$exe = (Resolve-Path (Join-Path $PSScriptRoot '..\dist\HafifStudyo.exe')).Path
$desk = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desk 'Hafif Stüdyo.lnk'))
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = Split-Path $exe
$lnk.IconLocation = "$exe,0"
$lnk.Description = 'Hafif Stüdyo - 3D, video ve web yapılış stüdyosu'
$lnk.Save()
Write-Output "Kısayol: $(Join-Path $desk 'Hafif Stüdyo.lnk')"
