$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('damare-native-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $target = Join-Path $temporary 'BouyomiBridge.exe'
    $source = (Resolve-Path (Join-Path $PSScriptRoot '..\apps\desktop\native\BouyomiBridge.cs')).Path
    & $compiler /nologo /target:exe /platform:x86 /reference:System.Web.Extensions.dll "/out:$target" $source
    if ($LASTEXITCODE -ne 0) { throw 'Native bridge compilation failed' }
    $request = '{"operation":"process","text":"test","tagMode":"original"}'
    $output = $request | & $target $temporary
    if ($LASTEXITCODE -ne 1 -or $output -notmatch '"error"') { throw 'Native bridge must report missing user-supplied assembly as JSON' }
    $probe = Join-Path $temporary 'NativeReadingProbe.exe'
    $probeSource = Join-Path $PSScriptRoot 'native-reading-probe.cs'
    & $compiler /nologo /target:exe /platform:x86 /main:NativeReadingProbe /reference:System.Web.Extensions.dll "/out:$probe" $source $probeSource
    if ($LASTEXITCODE -ne 0) { throw 'Native reading probe compilation failed' }
    & $probe
    if ($LASTEXITCODE -ne 0) { throw 'Native reading provenance check failed' }
    Write-Host 'Native x86 bridge compilation and JSON error protocol passed.'
} finally { Remove-Item -Path $temporary -Recurse -Force }
exit 0
