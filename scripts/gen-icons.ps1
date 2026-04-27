param(
  [string]$Src = "build/icons/1024x1024.png",
  [string]$BuildDir = "build"
)

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path ".").Path
$srcPath = Join-Path $root $Src
$buildPath = Join-Path $root $BuildDir
$iconsDir = Join-Path $buildPath "icons"

if (-not (Test-Path $srcPath)) {
  throw "Source not found: $srcPath"
}

Write-Host "Source: $srcPath"

$srcImage = [System.Drawing.Image]::FromFile($srcPath)

# Sizes for build/icons (Linux) and ICO/ICNS composition
$sizes = @(16, 32, 48, 64, 128, 256, 512)

foreach ($size in $sizes) {
  $dst = Join-Path $iconsDir "${size}x${size}.png"
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($srcImage, 0, 0, $size, $size)
  $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  Write-Host "  -> $dst"
}

$srcImage.Dispose()

# Copy 1024 as root icon.png for electron-builder
Copy-Item $srcPath (Join-Path $buildPath "icon.png") -Force
Write-Host "  -> $(Join-Path $buildPath 'icon.png')"

Write-Host "PNG regeneration complete."
