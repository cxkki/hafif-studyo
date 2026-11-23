<#
  Hafif Stüdyo canlı mod uçtan uca testi (video, 3D, web).
  Kullanım: powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-canli.ps1
  Uygulama penceresini açar; her adım sonunda GEÇTİ/KALDI yazar, çıkış kodu = kalan sayısı.
#>
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$hs = [IO.Path]::GetFullPath((Join-Path $here '..\dist\hs-run.ps1'))
$docs = [Environment]::GetFolderPath('MyDocuments')
$jobs = Join-Path $docs 'HafifStudyo\isler'
$utf8 = New-Object Text.UTF8Encoding($false)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$results = New-Object System.Collections.ArrayList

function Check([string]$step, [bool]$ok, [string]$note) {
  $state = if ($ok) { 'GEÇTİ' } else { 'KALDI' }
  $col = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("[{0}] {1} - {2}" -f $state, $step, $note) -ForegroundColor $col
  [void]$results.Add([pscustomobject]@{ Adim = $step; Durum = $state; Not = $note })
}

# hs-run'ı ayrı süreçte çalıştırır; @{ Code; Out } döner.
function Invoke-Hs([string[]]$HsArgs) {
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $hs @HsArgs 2>&1 | Out-String
  return @{ Code = $LASTEXITCODE; Out = $out.Trim() }
}

function Get-ProjectPath([string]$out) {
  $m = [regex]::Match($out, '(?m)^PROJE:\s*(.+?)\s*$')
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

function Read-Json([string]$path) {
  return (Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Save-Json($obj, [string]$path) {
  [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 10), $utf8)
}

function Set-Prop($obj, [string]$name, $value) {
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value }
  else { Add-Member -InputObject $obj -NotePropertyName $name -NotePropertyValue $value -Force }
}

function Get-Probe([string]$file) {
  $raw = & ffprobe -v error -select_streams v:0 -show_entries 'stream=codec_name,width,height:format=duration' -of json $file 2>&1 | Out-String
  $j = $raw | ConvertFrom-Json
  $s = $j.streams | Select-Object -First 1
  $d = 0.0
  if ($j.format -and $j.format.duration) { $d = [double]::Parse([string]$j.format.duration, [Globalization.CultureInfo]::InvariantCulture) }
  return [pscustomobject]@{ Codec = $s.codec_name; W = [int]$s.width; H = [int]$s.height; Dur = $d }
}

function Get-Outputs([string]$out) {
  try { $j = $out | ConvertFrom-Json; return @($j.outputs) } catch { return @() }
}

function Close-Live {
  $r = Invoke-Hs @('-Close', '-TimeoutSec', '300')
  return $r
}

# ---------------------------------------------------------------- 1. Açık oturumu kapat
try {
  if (Test-Path (Join-Path $jobs 'canli.running.json')) {
    $r = Close-Live
    Check '1 Açık oturumu kapat' ($r.Code -eq 0) ("çıkış kodu $($r.Code)")
  } else {
    Check '1 Açık oturumu kapat' $true 'açık oturum yok'
  }
} catch { Check '1 Açık oturumu kapat' $false $_.Exception.Message }

# ---------------------------------------------------------------- 2. VIDEO
$proj = $null
try {
  $nm = "test-canli-video-$stamp"
  $r = Invoke-Hs @('-New', 'tiktok-oyun', '-Name', $nm, '-TimeoutSec', '120')
  $proj = Get-ProjectPath $r.Out
  Check '2a Video: -New' (($r.Code -eq 0) -and [bool]$proj) ("çıkış $($r.Code); proje: $proj")
  if (-not $proj) { throw 'PROJE yolu ayrıştırılamadı' }
  Start-Sleep -Seconds 25

  $pj = Join-Path $proj 'proje.json'
  $p = Read-Json $pj
  Set-Prop $p.texts[0] 'color' '#ffd400'
  Set-Prop $p.texts[0] 'size' 8.5
  $kalan = @($p.texts | Where-Object { $_.id -ne 't2' })
  $yeni = [pscustomobject][ordered]@{
    id = 't9'; text = 'Test yazısı'; start = 9; duration = 2; size = 7
    color = '#ffffff'; stroke = $true; anim = 'pop'; y = 0.35
  }
  $p.texts = @($kalan + $yeni)
  Save-Json $p $pj
  Check '2b Video: proje.json düzenlendi' $true ("yazı sayısı: $($p.texts.Count)")
  Start-Sleep -Seconds 25

  $r = Invoke-Hs @('-Export', '-TimeoutSec', '600')
  $outs = Get-Outputs $r.Out
  $mp4 = $outs | Where-Object { $_ -like '*.mp4' } | Select-Object -First 1
  if (-not $mp4) { $mp4 = $outs | Select-Object -First 1 }
  Check '2c Video: -Export' (($r.Code -eq 0) -and [bool]$mp4 -and (Test-Path $mp4)) ("çıkış $($r.Code); $mp4 $(if ($r.Code -ne 0) { ($r.Out -replace 's+', ' ') })")
  if ($mp4 -and (Test-Path $mp4)) {
    $pr = Get-Probe $mp4
    $ok = ($pr.Codec -eq 'h264') -and ($pr.W -eq 1080) -and ($pr.H -eq 1920) -and ($pr.Dur -gt 5)
    Check '2d Video: ffprobe' $ok ("$($pr.Codec) $($pr.W)x$($pr.H) süre $([math]::Round($pr.Dur,2)) sn")
    $cikti = Join-Path $proj 'cikti'
    New-Item -ItemType Directory -Force $cikti | Out-Null
    foreach ($t in '0.5', '9.5') {
      $png = Join-Path $cikti "kare-$t.png"
      & ffmpeg -y -v error -ss $t -i $mp4 -frames:v 1 $png 2>&1 | Out-Null
      Check "2e Video: kare $t sn" (Test-Path $png) $png
    }
  }
} catch { Check '2 Video' $false $_.Exception.Message }
try { $r = Close-Live; Check '2f Video: -Close' ($r.Code -eq 0) ("çıkış $($r.Code)") } catch { Check '2f Video: -Close' $false $_.Exception.Message }

# ---------------------------------------------------------------- 3. 3D
try {
  $nm = "test-canli-3d-$stamp"
  $r = Invoke-Hs @('-New', 'urun-3d', '-Name', $nm, '-TimeoutSec', '120')
  $proj = Get-ProjectPath $r.Out
  Check '3a 3D: -New' (($r.Code -eq 0) -and [bool]$proj) ("çıkış $($r.Code); proje: $proj")
  if (-not $proj) { throw 'PROJE yolu ayrıştırılamadı' }
  Start-Sleep -Seconds 25

  $pj = Join-Path $proj 'proje.json'
  $p = Read-Json $pj
  Set-Prop $p.scene 'background' '#0f1a3a'
  $kalan = @($p.objects | Where-Object { $_.id -ne 'o3' })
  $kure = [pscustomobject][ordered]@{
    id = 'o9'; shape = 'sphere'; name = 'Test küre'
    position = [double[]]@(1.5, 0.55, 0.4); scale = 0.5; color = '#ff7a45'
  }
  $p.objects = @($kalan + $kure)
  Save-Json $p $pj
  Check '3b 3D: proje.json düzenlendi' $true ("nesne sayısı: $($p.objects.Count)")
  Start-Sleep -Seconds 20

  $r = Invoke-Hs @('-Export', '-TimeoutSec', '600')
  $outs = Get-Outputs $r.Out
  $png = $outs | Where-Object { $_ -like '*.png' } | Select-Object -First 1
  Check '3c 3D: -Export png' (($r.Code -eq 0) -and [bool]$png -and (Test-Path $png)) ("çıkış $($r.Code); $png $(if ($r.Code -ne 0) { ($r.Out -replace 's+', ' ') })")
  if ($png -and (Test-Path $png)) {
    $pr = Get-Probe $png
    Check '3d 3D: png boyutu' (($pr.W -eq 1920) -and ($pr.H -eq 1080)) ("$($pr.W)x$($pr.H); $png")
  }
} catch { Check '3 3D' $false $_.Exception.Message }
try { $r = Close-Live; Check '3e 3D: -Close' ($r.Code -eq 0) ("çıkış $($r.Code)") } catch { Check '3e 3D: -Close' $false $_.Exception.Message }

# ---------------------------------------------------------------- 4. WEB
try {
  $nm = "test-canli-web-$stamp"
  $site = Join-Path $docs "HafifStudyo\projeler\$nm"
  New-Item -ItemType Directory -Force $site | Out-Null
  $r = Invoke-Hs @('-Live', $site, '-Record', '-Orientation', 'vertical', '-Name', $nm, '-TimeoutSec', '120')
  Check '4a Web: -Live' ($r.Code -eq 0) ("çıkış $($r.Code)")
  if ($r.Code -ne 0) { throw $r.Out }

  $r = Invoke-Hs @('-Say', 'Test başlıyor')
  Check '4b Web: -Say' ($r.Code -eq 0) ("çıkış $($r.Code)")
  Start-Sleep -Seconds 2

  $html = @'
<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test Sayfası</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<h1>Merhaba Dünya</h1>
<p>Bu, Hafif Stüdyo canlı mod testi için yazılmış bir paragraf.</p>
</body>
</html>
'@
  [IO.File]::WriteAllText((Join-Path $site 'index.html'), $html, $utf8)
  Start-Sleep -Seconds 12

  $css = @'
body { background: #0f1a3a; color: #e8eefc; font-family: system-ui, sans-serif; padding: 48px; }
h1 { color: #ffd400; font-size: 64px; }
p { font-size: 32px; }
'@
  [IO.File]::WriteAllText((Join-Path $site 'style.css'), $css, $utf8)
  Start-Sleep -Seconds 12

  $html2 = $html.Replace('</body>', "<section>`n<h2>Yeni Bölüm</h2>`n<p>Canlı modda sonradan eklenen bölüm.</p>`n</section>`n</body>")
  [IO.File]::WriteAllText((Join-Path $site 'index.html'), $html2, $utf8)
  Check '4c Web: dosyalar yazıldı' $true $site
  Start-Sleep -Seconds 15

  $r = Invoke-Hs @('-LiveStop', '-TimeoutSec', '600')
  $outs = Get-Outputs $r.Out
  $mp4 = $outs | Select-Object -First 1
  Check '4d Web: -LiveStop' (($r.Code -eq 0) -and [bool]$mp4 -and (Test-Path $mp4)) ("çıkış $($r.Code); $mp4")
  if ($mp4 -and (Test-Path $mp4)) {
    Check '4e Web: dosya adı -canli.mp4' ($mp4 -like '*-canli.mp4') ([IO.Path]::GetFileName($mp4))
    $pr = Get-Probe $mp4
    $ok = ($pr.W -eq 1080) -and ($pr.H -eq 1920) -and ($pr.Dur -gt 5)
    Check '4f Web: ffprobe' $ok ("$($pr.Codec) $($pr.W)x$($pr.H) süre $([math]::Round($pr.Dur,2)) sn")
    $parca = @(Get-ChildItem (Split-Path $mp4) -Filter '*-parca-*.mp4' -ErrorAction SilentlyContinue)
    Check '4g Web: parça dosyası kalmadı' ($parca.Count -eq 0) ("kalan parça: $($parca.Count)")
  }
} catch {
  Check '4 Web' $false $_.Exception.Message
  try { Close-Live | Out-Null } catch {}
}

# ---------------------------------------------------------------- Özet
Write-Host ''
Write-Host '=== ÖZET ===' -ForegroundColor Cyan
$results | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host
$fail = @($results | Where-Object { $_.Durum -eq 'KALDI' }).Count
$pass = @($results | Where-Object { $_.Durum -eq 'GEÇTİ' }).Count
Write-Host ("GEÇTİ: $pass   KALDI: $fail") -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
exit $fail
