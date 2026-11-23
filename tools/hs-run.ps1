<#
  Hafif Stüdyo tarif çalıştırıcı (Claude ve komut satırı için).

  Tarif:
    hs-run.ps1 -Recipe C:\yol\tarif.json -Headless        (pencere açmadan çalıştır, bitince sonucu yazdır)
    hs-run.ps1 -Recipe tarif.json -Queue                  (açık uygulamanın iş klasörüne bırakır)

  Canlı mod (Claude siteyi yazarken Hafif Stüdyo'da canlı izle):
    hs-run.ps1 -Live C:\yol\site [-Record] [-Orientation vertical|horizontal] [-Name ad]
                                                          (uygulamayı açar, klasörü izlemeye başlar; uygulama işi alınca döner)
    hs-run.ps1 -Say "Hero bölümünü yazıyorum"             (uygulamada "Claude:" notu gösterir)
    hs-run.ps1 -LiveStop                                  (oturumu bitirir; -Record ise videonun yolunu yazdırır)

  Sonuç: <tarif>.done.json ya da <tarif>.error.json içeriği yazdırılır.
  Çıkış kodu: 0 = başarılı, 1 = tarif hatası, 2 = zaman aşımı,
              3 = uygulama durum dosyası yazmadan kapandı (pencere kapatıldı, çöktü ya da klasör yazılamıyor; komut satırı modu)
                  ya da canlı komutta (-New/-Open/-Live/-Export/-Close/-Say) uygulama kapalı.
#>
param(
  [string]$Recipe,
  [switch]$Headless,
  [switch]$RecordBuild,
  [ValidateSet('1x', '2x', '5x', 'instant')][string]$Speed,
  [switch]$Queue,
  [string]$Live,
  [switch]$Record,
  [ValidateSet('vertical', 'horizontal')][string]$Orientation = 'horizontal',
  [string]$Name = 'canli',
  [string]$Music,
  [string]$Say,
  [switch]$LiveStop,
  [string]$New,
  [string]$Open,
  [switch]$Export,
  [string]$File,
  [switch]$Close,
  [int]$TimeoutSec = 1800
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$exe = Join-Path $PSScriptRoot 'HafifStudyo.exe'
if (-not (Test-Path $exe)) { $exe = Join-Path $PSScriptRoot '..\dist\HafifStudyo.exe' }
$jobs = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'HafifStudyo\isler'
New-Item -ItemType Directory -Force $jobs | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$proc = $null

function Write-ResultAndExit {
  if (Test-Path "$base.done.json") { Get-Content "$base.done.json" -Raw -Encoding UTF8; exit 0 }
  if (Test-Path "$base.error.json") { Get-Content "$base.error.json" -Raw -Encoding UTF8; exit 1 }
}

# Göreli yollar PowerShell konumuna göre çözülür (Set-Location sonrası da doğru; [IO.Path]::GetFullPath değil).
function Get-FullPath($p) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p) }

# ------------------------------------------------------------------ canlı oturum sahipliği
# canli.running.json'da işi süren uygulamanın pid'i yazar. Süreç yoksa dosya kalıntıdır
# (pencere oturum sürerken kapatıldı): yeni oturum açılabilir, -Close/-Export beklemeden 3 ile çıkar.
function Get-LivePid {
  $rf = Join-Path $jobs 'canli.running.json'
  if (-not (Test-Path $rf)) { return $null }
  try { $j = Get-Content $rf -Raw -Encoding UTF8 | ConvertFrom-Json; if ($j.pid) { return [int]$j.pid } } catch {}
  return 0
}
function Test-AppAlive($procId) {
  if ($procId) { return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue) }
  return [bool](Get-Process HafifStudyo -ErrorAction SilentlyContinue)
}
function Clear-StaleLive {
  $lp = Get-LivePid
  if ($null -eq $lp) { return $false }
  if (Test-AppAlive $lp) { return $false }
  Remove-Item (Join-Path $jobs 'canli.running.json'), (Join-Path $jobs 'canli.json'), (Join-Path $jobs 'canli.proje') -ErrorAction SilentlyContinue
  return $true
}

# ------------------------------------------------------------------ canlı proje (docs/CANLI.md)
function Start-LiveJob($obj, $label, [switch]$NeedProje) {
  $script:base = Join-Path $jobs 'canli'
  if (Test-Path "$base.running.json") {
    if (Clear-StaleLive) { Write-Output 'Not: önceki canlı oturumun uygulaması kapanmış; kalıntı temizlendi.' }
    else { Write-Output 'Zaten açık bir canlı oturum var (önce -Close).'; exit 1 }
  }
  # Eski oturumun canli.json'u da silinmeli: yoksa done.json silinince uygulama onu "bekleyen iş" sanıp yeniden çalıştırır.
  Remove-Item "$base.json", "$base.done.json", "$base.error.json", (Join-Path $jobs 'canli.stop'), (Join-Path $jobs 'canli.say'), (Join-Path $jobs 'canli.export'), (Join-Path $jobs 'canli.proje') -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
  if (-not (Get-Process HafifStudyo -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) | Out-Null
    Start-Sleep -Seconds 3
  }
  [IO.File]::WriteAllText("$base.json", ($obj | ConvertTo-Json -Depth 5), $utf8)
  $pf = Join-Path $jobs 'canli.proje'
  $limit = 30
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $limit) {
    # Önce hata: açılış hatası "açıldı" diye bildirilmesin.
    if (Test-Path "$base.error.json") { Get-Content "$base.error.json" -Raw -Encoding UTF8; exit 1 }
    if (Test-Path "$base.running.json") {
      $limit = 180 # iş başladı: şablon kopyalama / açılış sürebilir
      if ((-not $NeedProje) -or (Test-Path $pf)) {
        Start-Sleep -Milliseconds 150
        if (Test-Path "$base.error.json") { Get-Content "$base.error.json" -Raw -Encoding UTF8; exit 1 }
        Write-Output $label
        if ($NeedProje) { Write-Output ("PROJE: " + (Get-Content $pf -Raw -Encoding UTF8).Trim()) }
        exit 0
      }
      $lp = Get-LivePid
      if ($lp -and -not (Test-AppAlive $lp)) {
        Start-Sleep -Milliseconds 300
        if (Test-Path "$base.error.json") { Get-Content "$base.error.json" -Raw -Encoding UTF8; exit 1 }
        Clear-StaleLive | Out-Null
        Write-Output 'HATA: uygulama canlı proje açılırken kapandı.'
        exit 3
      }
    } elseif (Test-Path "$base.done.json") {
      # Oturum açılıp hemen kapandı (ör. HUD X).
      Get-Content "$base.done.json" -Raw -Encoding UTF8; exit 0
    } elseif ($sw.Elapsed.TotalSeconds -gt 10 -and -not (Get-Process HafifStudyo -ErrorAction SilentlyContinue)) {
      Remove-Item "$base.json" -ErrorAction SilentlyContinue
      Write-Output 'HATA: Hafif Stüdyo çalışmıyor (açılamadı ya da kapandı); canlı iş iptal edildi.'
      exit 3
    }
    Start-Sleep -Milliseconds 500
  }
  if (Test-Path "$base.running.json") {
    Write-Output "ZAMAN AŞIMI: canlı iş başladı ama proje $limit sn içinde hazır olmadı (oturum açık kalabilir; kapatmak için -Close)."
    exit 2
  }
  # İş alınmadı: sırada kalıp dakikalar sonra kendiliğinden açılmasın.
  Remove-Item "$base.json" -ErrorAction SilentlyContinue
  if (Test-Path "$base.error.json") { Get-Content "$base.error.json" -Raw -Encoding UTF8; exit 1 }
  Write-Output 'ZAMAN AŞIMI: uygulama canlı işi 30 sn içinde almadı; iş iptal edildi (başka bir tarif çalışıyor olabilir ya da iş klasörü izlenmiyor; bitince yeniden dene).'
  exit 2
}

if ($New) {
  $nm = if ($PSBoundParameters.ContainsKey('Name')) { $Name } else { $New }
  Start-LiveJob ([ordered]@{ type = 'proje'; template = $New; name = $nm }) "Şablondan canlı proje açıldı: $New. Düzenlemek için aşağıdaki klasördeki proje.json'u değiştir." -NeedProje
}

if ($Open) {
  $p = Get-FullPath $Open
  if (-not (Test-Path (Join-Path $p 'proje.json'))) { Write-Output "proje.json yok: $p"; exit 1 }
  Start-LiveJob ([ordered]@{ type = 'proje'; path = $p.Replace('\', '/') }) "Canlı proje açıldı: $p. proje.json'u düzenledikçe Hafif Stüdyo'da görünecek." -NeedProje
}

if ($Export) {
  $eb = Join-Path $jobs 'canli.export'
  # Oturum sahibi süreç (yoksa herhangi bir Hafif Stüdyo; arayüzden açılan proje de dışa aktarılabilir).
  if (Clear-StaleLive) { Write-Output 'Uygulama kapalı: canlı oturum yarıda kalmış (kalıntı temizlendi); dışa aktarılacak açık proje yok.'; exit 3 }
  $lp = Get-LivePid
  if (-not (Test-AppAlive $lp)) { Write-Output 'Uygulama kapalı: dışa aktarılacak açık proje yok.'; exit 3 }
  Remove-Item "$eb.done.json", "$eb.error.json" -ErrorAction SilentlyContinue
  # id: önceki bir -Export'un geç yazılan sonucu bu isteğinki sanılmasın.
  $id = [guid]::NewGuid().ToString('N')
  $req = [ordered]@{ id = $id }
  if ($File) { $req.file = $File }
  [IO.File]::WriteAllText($eb, ($req | ConvertTo-Json), $utf8)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt [Math]::Min($TimeoutSec, 900)) {
    foreach ($k in @(@{ f = "$eb.done.json"; c = 0 }, @{ f = "$eb.error.json"; c = 1 })) {
      if (Test-Path $k.f) {
        $raw = $null
        try { $raw = Get-Content $k.f -Raw -Encoding UTF8; $r = $raw | ConvertFrom-Json } catch { $r = $null }
        if ($r -and ((-not $r.id) -or $r.id -eq $id)) { $raw; exit $k.c }
      }
    }
    if (-not (Test-AppAlive $lp)) {
      Write-Output 'HATA: uygulama dışa aktarma bitmeden kapandı.'
      Clear-StaleLive | Out-Null
      exit 3
    }
    Start-Sleep -Milliseconds 700
  }
  Write-Output 'ZAMAN AŞIMI: dışa aktarma bitmedi'
  exit 2
}

if ($Close) { $LiveStop = $true }

# ------------------------------------------------------------------ canlı mod
if ($Say) {
  if (-not (Get-Process HafifStudyo -ErrorAction SilentlyContinue)) { Write-Output 'Uygulama kapalı: not gösterilmedi.'; exit 3 }
  [IO.File]::WriteAllText((Join-Path $jobs 'canli.say'), $Say, $utf8)
  exit 0
}

if ($LiveStop) {
  $base = Join-Path $jobs 'canli'
  if (-not (Test-Path "$base.running.json")) {
    # Arayüzden (Şablonlar / Proje aç) açılmış canlı proje bir iş değildir: yine de kapat komutunu gönder.
    if (Get-Process HafifStudyo -ErrorAction SilentlyContinue) {
      [IO.File]::WriteAllText((Join-Path $jobs 'canli.stop'), 'stop', $utf8)
      Start-Sleep -Seconds 2
      Write-Output 'İş olarak başlatılmış canlı oturum yok; arayüzden açılmış bir proje varsa kapatıldı.'
      exit 0
    }
    Write-Output 'Çalışan bir canlı oturum yok (uygulama kapalı).'; exit 1
  }
  if (Clear-StaleLive) { Write-Output 'Uygulama kapalı: canlı oturum zaten bitmiş (pencere kapatılmış; kalıntı temizlendi).'; exit 3 }
  $lp = Get-LivePid
  [IO.File]::WriteAllText((Join-Path $jobs 'canli.stop'), 'stop', $utf8)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt [Math]::Min($TimeoutSec, 600)) {
    Write-ResultAndExit
    if (-not (Test-AppAlive $lp)) {
      Start-Sleep -Milliseconds 500
      Write-ResultAndExit
      Clear-StaleLive | Out-Null
      Remove-Item (Join-Path $jobs 'canli.stop') -ErrorAction SilentlyContinue
      Write-Output 'HATA: uygulama canlı oturum sonucu yazılmadan kapandı.'
      exit 3
    }
    Start-Sleep -Milliseconds 700
  }
  Write-Output "ZAMAN AŞIMI: canlı oturum bitmedi ($base.done.json yok)"
  exit 2
}

if ($Live) {
  $site = Get-FullPath $Live
  New-Item -ItemType Directory -Force $site | Out-Null
  $o = [ordered]@{ type = 'web-live'; name = $Name; site = $site.Replace('\', '/'); record = [bool]$Record; orientation = $Orientation }
  if ($Music) { $o.music = (Get-FullPath $Music).Replace('\', '/') }
  Start-LiveJob $o "Canlı mod başladı: $site (kayıt: $([bool]$Record)). Dosyaları yazdıkça Hafif Stüdyo'da görünecek. Bitirmek için: -LiveStop"
}

# ------------------------------------------------------------------ tarif
if (-not $Recipe) { Write-Output 'Kullanım: -Recipe tarif.json | -Live klasör | -Say "not" | -LiveStop'; exit 1 }
$Recipe = (Resolve-Path $Recipe).Path

if ($Queue) {
  $target = Join-Path $jobs ([IO.Path]::GetFileName($Recipe))
  $base = $target -replace '\.json$', ''
  Remove-Item "$base.done.json", "$base.error.json" -ErrorAction SilentlyContinue
  # Göreli medya yolları iş klasöründe de çalışsın: tarife baseDir ekle.
  $json = Get-Content $Recipe -Raw -Encoding UTF8
  $dir = (Split-Path $Recipe).Replace('\', '/')
  if ($json -notmatch '"baseDir"') { $json = ([regex]'^\s*\{').Replace($json, ("{`r`n  ""baseDir"": """ + $dir + ""","), 1) }
  [IO.File]::WriteAllText($target, $json, $utf8)
} else {
  $base = $Recipe -replace '\.json$', ''
  Remove-Item "$base.done.json", "$base.error.json" -ErrorAction SilentlyContinue
  $a = @('--run', "`"$Recipe`"")
  if ($Headless) { $a += '--headless' }
  if ($RecordBuild) { $a += '--record-build' }
  if ($Speed) { $a += '--speed'; $a += $Speed }
  # Süreci izle: uygulama durum dosyası yazmadan kapanırsa 30 dk beklemeden hata ver.
  $proc = Start-Process -FilePath $exe -ArgumentList $a -WorkingDirectory (Split-Path $Recipe) -PassThru
  $null = $proc.Handle # PowerShell 5.1: ExitCode'un çıkıştan sonra okunabilmesi için tutamağı şimdi al
}

$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
  Write-ResultAndExit
  if ($proc -and $proc.HasExited) {
    # Dosya tam çıkış anında yazılmış olabilir: kısa bekleyip bir kez daha bak.
    Start-Sleep -Milliseconds 500
    Write-ResultAndExit
    Write-Output "HATA: Uygulama durum dosyası yazmadan çıktı (kod $($proc.ExitCode)). Pencere kapatılmış, uygulama çökmüş ya da tarifin klasörü yazılamıyor olabilir ($base.done.json yok)."
    exit 3
  }
  Start-Sleep -Milliseconds 700
}
Write-Output "ZAMAN AŞIMI: $TimeoutSec sn içinde durum dosyası oluşmadı ($base.done.json)"
exit 2
