$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$iconPath = (Resolve-Path (Join-Path $root $manifest.build.win.icon)).Path
$expectedIcon = [System.Drawing.Icon]::new($iconPath, 32, 32)
$expected = $expectedIcon.ToBitmap()
try {
    $application = Get-Item (Join-Path $root 'dist\desktop\win-unpacked\NyanTalk-Damare.exe')
    $installers = @(Get-ChildItem (Join-Path $root 'dist\desktop') -Filter 'NyanTalk-Damare-Setup-*.exe')
    if ($installers.Count -ne 1) { throw 'Windows installer was not generated.' }
    foreach ($file in @($application) + $installers) {
        $actualIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($file.FullName)
        if ($null -eq $actualIcon) { throw "Executable icon missing: $($file.Name)" }
        $actual = $actualIcon.ToBitmap()
        try {
            if ($actual.Width -ne 32 -or $actual.Height -ne 32) { throw "Unexpected icon size: $($file.Name)" }
            for ($y = 0; $y -lt 32; $y++) {
                for ($x = 0; $x -lt 32; $x++) {
                    $a = $actual.GetPixel($x, $y); $b = $expected.GetPixel($x, $y)
                    if ($a.A -ne $b.A -or ($a.A -gt 0 -and ($a.R -ne $b.R -or $a.G -ne $b.G -or $a.B -ne $b.B))) {
                        throw "Cat icon differs at pixel $x,$y : $($file.Name)"
                    }
                }
            }
            Write-Output "Verified cat icon in $($file.Name)"
        } finally { $actual.Dispose(); $actualIcon.Dispose() }
    }
} finally { $expected.Dispose(); $expectedIcon.Dispose() }
exit 0
